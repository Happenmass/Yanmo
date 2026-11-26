import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpmClient, AcpmError, discoverAcpmRuntime } from '../desktop/acpm';
import { cocoaNow, defaultSettings, type Manuscript } from '../desktop/shared';
import { LibraryStore } from '../desktop/store';
import { signPopHeaders } from '../desktop/sync-crypto';
import { UdpMdnsBrowser } from '../desktop/sync-discovery';
import { SyncEngine } from '../desktop/sync-engine';
import {
  MemoryKnownHubStore,
  MemorySyncSecretStore,
  SyncPairingService,
} from '../desktop/sync-pairing';

function logStep(step: string, detail?: unknown) {
  if (detail !== undefined) {
    console.log(`[PASS] ${step}`, detail);
  } else {
    console.log(`[PASS] ${step}`);
  }
}

function makeEndpoint(name: string, tmpRoot: string) {
  const dir = mkdtempSync(join(tmpRoot, `${name}-`));
  const store = new LibraryStore(dir, defaultSettings());
  const secretStore = new MemorySyncSecretStore();
  const hubStore = new MemoryKnownHubStore();
  const pairing = new SyncPairingService({
    secretStore,
    hubStore,
    localAddressesProvider: () => ['127.0.0.1'],
  });
  const engine = new SyncEngine({
    store,
    secretStore,
    hubStore,
  });
  return {
    dir,
    store,
    secretStore,
    hubStore,
    pairing,
    engine,
    close() {
      store.close();
    },
  };
}

async function main() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'yanmo-live-sync-'));
  const devA = makeEndpoint('mac-a', tmpRoot);
  const devB = makeEndpoint('android-b', tmpRoot);
  const devC = makeEndpoint('win-c', tmpRoot);
  const devD = makeEndpoint('colleague-d', tmpRoot);
  const localClient = new AcpmClient({ mode: 'local', caller: 'yanmo-live-check' });
  const deviceIdsToRevoke: string[] = [];

  try {
    // 1. 本机发现与 mDNS 核验
    const disc = discoverAcpmRuntime();
    assert.ok(disc.hub_instance_id, 'runtime.json 缺少 hub_instance_id');
    assert.ok(disc.server_pubkey_fp, 'runtime.json 缺少 server_pubkey_fp');
    const hubIdInfo = await localClient.hubIdentity();
    assert.equal(hubIdInfo.hub_instance_id, disc.hub_instance_id);
    assert.equal(hubIdInfo.server_pubkey_fp, disc.server_pubkey_fp);
    logStep('1a. runtime.json 与 /v1/hub/identity 身份及签名核验通过', {
      hubId: hubIdInfo.hub_instance_id,
      fp: hubIdInfo.server_pubkey_fp,
    });

    const mdnsFound = await new UdpMdnsBrowser().discover(2500);
    const mdnsSelf = mdnsFound.find(h => h.hubInstanceId === hubIdInfo.hub_instance_id);
    assert.ok(mdnsSelf, `mDNS 未发现本机 Hub ${hubIdInfo.hub_instance_id}`);
    assert.equal(mdnsSelf.serverPubkeyFp, hubIdInfo.server_pubkey_fp);
    assert.equal(mdnsSelf.syncEnabled, true);
    logStep('1b. mDNS _acpm._tcp.local. 发现核验通过', {
      serviceName: mdnsSelf.serviceName,
      addresses: mdnsSelf.addresses,
      port: mdnsSelf.port,
    });

    // 2. Phase 1: 本机初始化 + 邀请扫码 + 用后即焚 + 5 次错码 + 反向扫码 join_wait + mDNS 发现
    const statusA = await devA.pairing.enableOnLocalHub('Yanmo-LiveCheck-Mac', 'macos');
    deviceIdsToRevoke.push(statusA.deviceId);
    assert.equal(statusA.enabled, true);
    assert.ok(statusA.vaultId);
    const vaultId = statusA.vaultId;
    logStep('2a. Device A 本机初始化 vault 注册成功', { vaultId, deviceId: statusA.deviceId });

    const invite = await devA.pairing.createInvitePairing({ advertiseAddrs: ['127.0.0.1'] });
    const seedA = devA.secretStore.load()!.rootSeedB64!;
    assert.equal(invite.qrUri.includes(seedA), false, '二维码不得包含裸 root_seed');

    const statusB = await devB.pairing.redeemInvitePairing(invite.qrUri, 'Yanmo-LiveCheck-Android', 'android');
    deviceIdsToRevoke.push(statusB.deviceId);
    assert.equal(statusB.enabled, true);
    assert.equal(statusB.vaultId, vaultId);
    logStep('2b. Device B 邀请扫码兑换并激活 yanmo.sync 成功', { deviceId: statusB.deviceId });

    // 一次性信箱用后即焚
    const rogue = makeEndpoint('rogue', tmpRoot);
    try {
      await assert.rejects(
        rogue.pairing.redeemInvitePairing(invite.qrUri, 'Rogue', 'android'),
        (err: unknown) => err instanceof AcpmError && err.httpStatus === 404,
      );
    } finally {
      rogue.close();
    }
    logStep('2c. 一次性配对信箱用后即焚验证通过 (404)');

    // 连续 5 次输错配对码作废
    const inviteWrong = await devA.pairing.createInvitePairing({ advertiseAddrs: ['127.0.0.1'] });
    const badAttempt = makeEndpoint('bad', tmpRoot);
    try {
      for (let i = 0; i < 5; i++) {
        const wrongQr = JSON.stringify({ ...inviteWrong.qrPayload, code: '00000000' });
        await assert.rejects(badAttempt.pairing.redeemInvitePairing(wrongQr, 'Bad', 'android'));
      }
      await assert.rejects(
        badAttempt.pairing.redeemInvitePairing(inviteWrong.qrUri, 'Late', 'android'),
        (err: unknown) => err instanceof AcpmError && err.httpStatus === 404,
      );
    } finally {
      badAttempt.close();
    }
    logStep('2d. 连续 5 次错码作废会话验证通过');

    // join_wait 反向扫码 + X25519 ECDH 交接
    const joinWait = await devC.pairing.createJoinWaitPairing({ advertiseAddrs: ['127.0.0.1'] });
    await devB.pairing.fulfillJoinWaitAsExistingDevice(joinWait.qrUri, 'Yanmo-LiveCheck-Android', 'android');
    const statusC = await devC.pairing.completeJoinWaitOnNewDevice(joinWait.sessionId, 'Yanmo-LiveCheck-Win', 'windows');
    deviceIdsToRevoke.push(statusC.deviceId);
    assert.equal(statusC.enabled, true);
    assert.equal(statusC.vaultId, vaultId);
    logStep('2e. join_wait 反向扫码与 X25519 ECDH 交接验证通过', { deviceId: statusC.deviceId });

    // 真实 mDNS 发现连通性
    const discKnown = await devB.pairing.discoverKnownHubs(2500);
    assert.ok(discKnown.matched.some(m => m.hubInstanceId === hubIdInfo.hub_instance_id), 'discoverKnownHubs 未匹配到实机 Hub');
    logStep('2f. discoverKnownHubs() 真实 mDNS 发现并验签通过', discKnown);

    // 3. Phase 1: PoP 分权隔离、防重放与设备吊销
    const infInvite = await devA.pairing.createInvitePairing({ scopes: ['inference'], advertiseAddrs: ['127.0.0.1'] });
    const statusD = await devD.pairing.redeemInvitePairing(infInvite.qrUri, 'Yanmo-LiveCheck-Colleague', 'android');
    deviceIdsToRevoke.push(statusD.deviceId);
    const devDSecrets = devD.secretStore.load()!;

    const colClient = new AcpmClient({
      mode: 'remote',
      remoteBaseURL: disc.http_base_url,
      popAuth: {
        deviceId: devDSecrets.deviceId,
        privateSeed: Buffer.from(devDSecrets.devicePrivateSeedB64, 'base64url'),
        serverPubkey: hubIdInfo.server_pubkey,
        expectedServerPubkeyFp: hubIdInfo.server_pubkey_fp,
      },
    });
    const colModels = await colClient.models();
    assert.ok(Array.isArray(colModels));
    const colForbidden = await fetch(`${disc.http_base_url}/v1/sync/vaults/${vaultId}/changes`, {
      method: 'GET',
      headers: signPopHeaders(
        devDSecrets.deviceId,
        Buffer.from(devDSecrets.devicePrivateSeedB64, 'base64url'),
        'GET',
        `/v1/sync/vaults/${vaultId}/changes`,
      ),
    });
    assert.equal(colForbidden.status, 403, `仅 inference 设备访问同步接口应返回 403，实际为 ${colForbidden.status}`);
    logStep('3a. PoP scopes 隔离验证通过 (inference 200, sync 403)');

    // Nonce 防重放
    const devBSecrets = devB.secretStore.load()!;
    const syncPath = `/v1/sync/vaults/${vaultId}/changes?since_seq=0&limit=10`;
    const fixedHeaders = signPopHeaders(
      devBSecrets.deviceId,
      Buffer.from(devBSecrets.devicePrivateSeedB64, 'base64url'),
      'GET',
      syncPath,
    );
    const firstTry = await fetch(`${disc.http_base_url}${syncPath}`, { method: 'GET', headers: fixedHeaders });
    assert.equal(firstTry.status, 200, `首次 PoP 请求应返回 200，实际为 ${firstTry.status}`);
    const replayTry = await fetch(`${disc.http_base_url}${syncPath}`, { method: 'GET', headers: fixedHeaders });
    assert.equal(replayTry.status, 401, `重放 Nonce 应返回 401，实际为 ${replayTry.status}`);
    logStep('3b. PoP Nonce 防重放验证通过 (200 -> 401)');

    // 设备列表、改名与吊销
    const devicesBefore = await devA.pairing.listDevices();
    assert.ok(devicesBefore.some(d => d.device_id === statusD.deviceId));
    const updatedD = await devA.pairing.updateDevice(statusD.deviceId, { device_name: 'Colleague-Renamed' });
    assert.equal(updatedD.device_name, 'Colleague-Renamed');
    const revokedD = await devA.pairing.revokeDevice(statusD.deviceId);
    assert.equal(revokedD.device_id, statusD.deviceId);
    assert.ok(revokedD.revoked_at_ms > 0);
    await assert.rejects(
      colClient.models(),
      (err: unknown) => err instanceof AcpmError && err.httpStatus === 403,
    );
    logStep('3c. 设备 list / update / revoke 及吊销阻断验证通过');

    // 4. Phase 2: E2EE 双向增量同步与语义合并
    // 重设 Device B 的 knownHub lastKnownUrl 为 127.0.0.1 以保证本机联调稳定走回环 PoP
    const bHubs = devB.hubStore.load();
    devB.hubStore.save(bHubs.map(h => ({ ...h, lastKnownUrl: disc.http_base_url })));

    devA.engine.ensureConfigured();
    devB.engine.ensureConfigured();

    const m1: Manuscript = {
      id: `live-m1-${Date.now()}`,
      date: cocoaNow(),
      original: '联调测试口述原文',
      text: '联调测试整理正文。',
      seconds: 3.1,
      application: '言墨联调',
      polished: true,
    };
    devA.store.library.manuscripts.push(m1);
    devA.store.library.lexicon.push({
      id: 'live-t-a',
      term: '  ＡｃｐｍLiveTerm ',
      hint: '初始备注',
      aliases: ['lt1', 'lt-del'],
      group: 'ai_tools',
      matchCount: 3,
      createdAt: Date.now() - 2000,
    });
    devA.store.persist();

    const syncA1 = await devA.engine.syncWithHub(hubIdInfo.hub_instance_id);
    assert.equal(syncA1.appliedRemote, 2);

    // Device B 离线并发添加同规范词条
    devB.store.library.lexicon.push({
      id: 'live-t-b',
      term: 'acpmliveterm',
      hint: 'B端更新备注',
      aliases: ['lt2'],
      group: 'ai_tools',
      matchCount: 5,
      createdAt: Date.now() - 1000,
    });
    devB.store.persist();

    await devB.engine.syncWithHub(hubIdInfo.hub_instance_id);
    await devA.engine.syncWithHub(hubIdInfo.hub_instance_id);

    assert.equal(devA.store.library.manuscripts.some(m => m.id === m1.id), true);
    assert.equal(devB.store.library.manuscripts.some(m => m.id === m1.id), true);
    assert.equal(devA.store.library.lexicon.length, 1);
    assert.equal(devB.store.library.lexicon.length, 1);
    assert.equal(devA.store.library.lexicon[0].matchCount, 8);
    assert.equal(devB.store.library.lexicon[0].matchCount, 8);
    assert.deepEqual(new Set(devA.store.library.lexicon[0].aliases), new Set(['lt1', 'lt-del', 'lt2']));
    assert.deepEqual(new Set(devB.store.library.lexicon[0].aliases), new Set(['lt1', 'lt-del', 'lt2']));

    // 零乒乓检查
    const idleA = await devA.engine.syncWithHub(hubIdInfo.hub_instance_id);
    const idleB = await devB.engine.syncWithHub(hubIdInfo.hub_instance_id);
    assert.equal(idleA.pushed, 0);
    assert.equal(idleB.pushed, 0);
    logStep('4a. Phase 2 双向增量同步、词库去重合并与零乒乓验证通过');

    // 删别名不复活 & 离线删文稿不复活
    devA.store.library.lexicon[0].aliases = devA.store.library.lexicon[0].aliases!.filter(a => a !== 'lt-del');
    devA.store.library.manuscripts = devA.store.library.manuscripts.filter(m => m.id !== m1.id);
    devA.store.persist();

    await devA.engine.syncWithHub(hubIdInfo.hub_instance_id);
    await devB.engine.syncWithHub(hubIdInfo.hub_instance_id);
    assert.equal(devB.store.library.manuscripts.some(m => m.id === m1.id), false);
    assert.equal(devB.store.library.lexicon[0].aliases!.includes('lt-del'), false);
    logStep('4b. 删别名不复活与离线删文稿墓碑验证通过');

    // 本地保留期清理隔离 (SYNC-08)
    const mOld: Manuscript = {
      id: `live-mold-${Date.now()}`,
      date: cocoaNow() - 5 * 86400,
      original: '五天前测试',
      text: '五天前文稿。',
      seconds: 1.5,
      application: '备忘录',
      polished: false,
    };
    devA.store.library.manuscripts.push(mOld);
    devA.store.persist();
    await devA.engine.syncWithHub(hubIdInfo.hub_instance_id);
    await devB.engine.syncWithHub(hubIdInfo.hub_instance_id);
    assert.equal(devB.store.library.manuscripts.some(m => m.id === mOld.id), true);

    devB.store.settings.retention = 1;
    devB.store.prune();
    devB.store.persist();
    assert.equal(devB.store.library.manuscripts.some(m => m.id === mOld.id), false);

    await devB.engine.syncWithHub(hubIdInfo.hub_instance_id);
    await devA.engine.syncWithHub(hubIdInfo.hub_instance_id);
    assert.equal(devA.store.library.manuscripts.some(m => m.id === mOld.id), true);
    logStep('4c. 本地保留期清理隔离 (SYNC-08) 验证通过');

    // 5. Phase 3: 大附件 sync_blobs 秒传去重、按需拉取加密缓存与分权隔离
    const rawAudio = Buffer.from(`fLaC-live-blob-audio-${Date.now()}`);
    const rawScreenshot = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const mBlob: Manuscript = {
      id: `live-mblob-${Date.now()}`,
      date: cocoaNow(),
      recordingEndedAtMs: Date.now(),
      original: '大附件联调口述',
      text: '大附件联调正文。',
      seconds: 4.0,
      application: '言墨联调',
      polished: true,
    };
    devA.store.library.manuscripts.push(mBlob);
    devA.store.persist({ id: mBlob.id, audioOpus: rawAudio, screenshotImage: rawScreenshot });

    await devA.engine.syncWithHub(hubIdInfo.hub_instance_id, undefined, { uploadBlobs: true });
    const dedup = await devA.engine.uploadManuscriptBlobs(mBlob.id, hubIdInfo.hub_instance_id);
    assert.equal(dedup.uploaded.length, 0);
    assert.equal(dedup.skipped.length, 2);

    await devB.engine.syncWithHub(hubIdInfo.hub_instance_id);
    assert.deepEqual(devB.store.getAttachments(mBlob.id), {});

    const fetchedAttachments = await devB.engine.ensureManuscriptAttachments(mBlob.id, hubIdInfo.hub_instance_id);
    assert.deepEqual(Buffer.from(fetchedAttachments.audio!), rawAudio);
    assert.deepEqual(Buffer.from(fetchedAttachments.screenshot!), rawScreenshot);
    assert.deepEqual(Buffer.from(devB.store.getAttachments(mBlob.id).audio!), rawAudio);

    // 验证 inference-only 设备无权访问 sync_blobs (403)
    const devE = makeEndpoint('colleague-blob-e', tmpRoot);
    try {
      const infBlobInvite = await devA.pairing.createInvitePairing({ scopes: ['inference'], advertiseAddrs: ['127.0.0.1'] });
      const statusE = await devE.pairing.redeemInvitePairing(infBlobInvite.qrUri, 'Colleague-Blob', 'android');
      deviceIdsToRevoke.push(statusE.deviceId);
      const devESecrets = devE.secretStore.load()!;
      const blobId = dedup.skipped[0];
      const blobClientE = new AcpmClient({
        mode: 'remote',
        remoteBaseURL: disc.http_base_url,
        popAuth: {
          deviceId: devESecrets.deviceId,
          privateSeed: Buffer.from(devESecrets.devicePrivateSeedB64, 'base64url'),
          serverPubkey: hubIdInfo.server_pubkey,
          expectedServerPubkeyFp: hubIdInfo.server_pubkey_fp,
        },
      });
      await assert.rejects(
        blobClientE.downloadSyncBlob(vaultId, blobId),
        err => err instanceof AcpmError && err.httpStatus === 403,
      );
    } finally {
      devE.close();
    }
    logStep('5. Phase 3 大附件 sync_blobs 秒传、按需解密缓存与 403 分权验证通过');

    console.log('\n🎉 实机联调全部通过：Phase 1 + Phase 2 + Phase 3A 全链路验证成功！');
  } finally {
    for (const id of deviceIdsToRevoke) {
      await localClient.revokeDevice(id).catch(() => {});
    }
    devA.close();
    devB.close();
    devC.close();
    devD.close();
    rmSync(tmpRoot, { recursive: true, force: true });
    console.log('[CLEANUP] 已吊销全部合成测试设备并清理临时目录。');
  }
}

await main();
