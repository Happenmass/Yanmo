import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpmClient, AcpmError } from '../acpm';
import {
  blobAad,
  computeBlobId,
  computeLexiconRecordKey,
  computePubkeyFingerprint,
  decodeRecoveryCode,
  deriveSpaceKeys,
  encodeRecoveryCode,
  generateDeviceIdentity,
  generateRootSeed,
  openEnvelope,
  recordAad,
  sealEnvelope,
  signMembershipCert,
  signPopHeaders,
  verifyMembershipCert,
  verifyPopHeaders,
} from '../sync-crypto';
import {
  encodeMdnsPtrQuery,
  encodeMdnsServiceResponse,
  matchKnownHubs,
  parseMdnsPacket,
  resolveHubBaseUrl,
  type DiscoveredAcpmHub,
  type KnownHub,
} from '../sync-discovery';
import {
  FileKnownHubStore,
  MemoryKnownHubStore,
  MemorySyncSecretStore,
  parsePairingQr,
  SyncPairingService,
} from '../sync-pairing';
import { createMockSyncHub } from './sync-hub-mock';

test('密钥派生、恢复码、归属证书、密文信封与词库盲化去重键符合协议', () => {
  const rootSeed = generateRootSeed();
  const keys1 = deriveSpaceKeys(rootSeed);
  const keys2 = deriveSpaceKeys(rootSeed);

  assert.equal(keys1.vaultId.length, 26);
  assert.match(keys1.vaultId, /^[a-z2-7]{26}$/);
  assert.equal(keys1.vaultId, keys2.vaultId);
  assert.equal(keys1.ownerPublicKeyB64, keys2.ownerPublicKeyB64);
  assert.deepEqual(keys1.dataEncKey, keys2.dataEncKey);
  assert.deepEqual(keys1.keyMacKey, keys2.keyMacKey);

  // 恢复码编解码与防篡改校验
  const code = encodeRecoveryCode(rootSeed);
  assert.ok(code.startsWith('YM1-'));
  assert.deepEqual(decodeRecoveryCode(code.toLowerCase()), rootSeed);
  const flipChar = code[10] === 'A' ? 'B' : 'A';
  const corrupted = code.slice(0, 10) + flipChar + code.slice(11);
  assert.throws(() => decodeRecoveryCode(corrupted), /校验失败/);

  // 归属证书签名与篡改拦截
  const dev = generateDeviceIdentity();
  const cert = signMembershipCert(keys1.ownerPrivateKey, {
    version: 1,
    vault_id: keys1.vaultId,
    device_id: dev.deviceId,
    device_pubkey: dev.publicKeyB64,
    platform: 'android',
    issued_at_ms: 1795584800000,
  });
  assert.equal(verifyMembershipCert(keys1.ownerPublicKey, cert), true);
  assert.equal(verifyMembershipCert(keys1.ownerPublicKey, { ...cert, platform: 'windows' }), false);

  // AES-256-GCM 密文信封与 AAD 绑定
  const aad = recordAad(keys1.vaultId, 'lexicon', 'rk-1', '01795584812345-0000-dev1', false);
  const plain = Buffer.from(JSON.stringify({ term: 'AcpmRuntime', hint: '本地推理服务' }), 'utf8');
  for (const compress of [false, true]) {
    const sealed = sealEnvelope(keys1.dataEncKey, plain, aad, { compress });
    assert.deepEqual(openEnvelope(keys1.dataEncKey, sealed, aad), plain);
    const wrongAad = recordAad(keys1.vaultId, 'lexicon', 'rk-1', '01795584812345-0001-dev1', false);
    assert.throws(() => openEnvelope(keys1.dataEncKey, sealed, wrongAad));
  }

  // 词库盲化去重键对全半角、空格与大小写归一化一致；Blob ID 一致
  const rkMac = computeLexiconRecordKey(keys1.keyMacKey, '  Ａｃｐｍ   Runtime ');
  const rkAndroid = computeLexiconRecordKey(keys2.keyMacKey, 'acpm runtime');
  assert.equal(rkMac, rkAndroid);
  const blobId = computeBlobId(keys1.keyMacKey, 'a'.repeat(64));
  const blobEnv = sealEnvelope(keys1.dataEncKey, Buffer.from('fLaC'), blobAad(keys1.vaultId, blobId));
  assert.equal(openEnvelope(keys2.dataEncKey, blobEnv, blobAad(keys2.vaultId, blobId)).toString(), 'fLaC');
});

test('PoP 鉴权、Nonce 防重放、时间窗、响应签名与 scopes 分权隔离 (SYNC-06 / SYNC-07)', async () => {
  const hub = createMockSyncHub();
  const space = deriveSpaceKeys(generateRootSeed());
  const myDev = generateDeviceIdentity();
  const colleagueDev = generateDeviceIdentity();

  // 本地通道注册本人设备（全权限）
  const localClient = new AcpmClient({
    mode: 'remote',
    remoteBaseURL: hub.baseURL,
    remoteToken: hub.localToken,
    fetchImpl: hub.fetchImpl,
  });
  await localClient.registerVault({
    vault_id: space.vaultId,
    owner_pubkey: space.ownerPublicKeyB64,
    device_id: myDev.deviceId,
    device_pubkey: myDev.publicKeyB64,
    device_name: 'My Mac',
    platform: 'macos',
    membership_cert: signMembershipCert(space.ownerPrivateKey, {
      version: 1,
      vault_id: space.vaultId,
      device_id: myDev.deviceId,
      device_pubkey: myDev.publicKeyB64,
      platform: 'macos',
      issued_at_ms: Date.now(),
    }),
  });

  // 通过仅授予 inference 权限的配对会话接入同事设备（无 yanmo.sync）
  const colleagueSession = await localClient.createPairingSession({
    mode: 'inviter',
    scopes: ['inference'],
  });
  const colleagueAnon = new AcpmClient({ mode: 'remote', remoteBaseURL: hub.baseURL, fetchImpl: hub.fetchImpl });
  const redeemed = await colleagueAnon.redeemPairingSession({
    session_id: colleagueSession.session_id,
    acpm_pair_code: colleagueSession.acpm_pair_code,
    device_id: colleagueDev.deviceId,
    device_pubkey: colleagueDev.publicKeyB64,
    device_name: 'Colleague Phone',
    platform: 'android',
  });
  assert.deepEqual(redeemed.scopes, ['inference']);

  // 同事设备可调推理接口，但访问同步接口被 403 FORBIDDEN 拒绝 (SYNC-06)
  const colleaguePop = new AcpmClient({
    mode: 'remote',
    remoteBaseURL: hub.baseURL,
    popAuth: { deviceId: colleagueDev.deviceId, privateSeed: colleagueDev.privateSeed, serverPubkey: hub.serverPubkey },
    fetchImpl: hub.fetchImpl,
  });
  assert.equal((await colleaguePop.models()).length, 1);
  const forbiddenSync = await hub.fetchImpl(`${hub.baseURL}/v1/sync/vaults/${space.vaultId}/changes`, {
    method: 'GET',
    headers: signPopHeaders(colleagueDev.deviceId, colleagueDev.privateSeed, 'GET', `/v1/sync/vaults/${space.vaultId}/changes`),
  });
  assert.equal(forbiddenSync.status, 403);

  // 本人设备 PoP 访问同步与模型均成功
  const myPop = new AcpmClient({
    mode: 'remote',
    remoteBaseURL: hub.baseURL,
    popAuth: {
      deviceId: myDev.deviceId,
      privateSeed: myDev.privateSeed,
      serverPubkey: hub.serverPubkey,
      expectedServerPubkeyFp: hub.serverPubkeyFp,
    },
    fetchImpl: hub.fetchImpl,
  });
  assert.equal((await myPop.models()).length, 1);

  // Nonce 重放被 401 拦截 (SYNC-07)
  const path = `/v1/sync/vaults/${space.vaultId}/changes`;
  const fixedPop = signPopHeaders(myDev.deviceId, myDev.privateSeed, 'GET', path, undefined, { nonce: 'fixed-nonce-1' });
  const firstTry = await hub.fetchImpl(`${hub.baseURL}${path}`, { method: 'GET', headers: fixedPop });
  assert.equal(firstTry.status, 200);
  const replayTry = await hub.fetchImpl(`${hub.baseURL}${path}`, { method: 'GET', headers: fixedPop });
  assert.equal(replayTry.status, 401);

  // 超 ±120s 时间漂移与请求体篡改校验
  const staleHeaders = signPopHeaders(myDev.deviceId, myDev.privateSeed, 'POST', '/v1/devices', '{}', { timestampMs: Date.now() - 180_000 });
  assert.equal(verifyPopHeaders(myDev.publicKey, 'POST', '/v1/devices', '{}', staleHeaders).ok, false);
  const validPostHeaders = signPopHeaders(myDev.deviceId, myDev.privateSeed, 'POST', '/v1/devices', '{"a":1}');
  assert.equal(verifyPopHeaders(myDev.publicKey, 'POST', '/v1/devices', '{"a":2}', validPostHeaders).ok, false);

  // 服务端响应签名被篡改时 AcpmClient 拒绝
  hub.tamperNextServerSignature();
  await assert.rejects(
    myPop.models(),
    (err: unknown) => err instanceof AcpmError && err.code === 'FORBIDDEN',
  );

  // 单设备吊销后立即被拒绝
  await localClient.revokeDevice(colleagueDev.deviceId);
  await assert.rejects(
    colleaguePop.models(),
    (err: unknown) => err instanceof AcpmError && err.httpStatus === 403,
  );
});

test('mDNS DNS-SD 报文编解码、压缩指针防御与已知节点指纹过滤 (SYNC-07)', () => {
  const query = encodeMdnsPtrQuery();
  assert.equal(query.readUInt16BE(4), 1);

  const hubA: DiscoveredAcpmHub = {
    serviceName: 'acpm-mac-3c8e',
    host: 'acpm-mac.local',
    addresses: ['192.168.1.24'],
    port: 18790,
    hubInstanceId: '3c8e2a10-4b5d-4f6a-9c8d-1234567890ab',
    serverPubkeyFp: '9f4a1c8e2b7d0341',
    syncEnabled: true,
    apiPrefix: '/v1',
    txt: {},
  };
  const packet = encodeMdnsServiceResponse(hubA);
  const parsed = parseMdnsPacket(packet);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].hubInstanceId, hubA.hubInstanceId);
  assert.equal(parsed[0].serverPubkeyFp, hubA.serverPubkeyFp);
  assert.deepEqual(parsed[0].addresses, ['192.168.1.24']);
  assert.equal(parsed[0].port, 18790);
  assert.equal(parsed[0].syncEnabled, true);

  // 压缩指针环路（pointer -> 自身）不会死循环或抛异常
  const loopPacket = Buffer.alloc(24);
  loopPacket.writeUInt16BE(1, 4); // qdcount = 1
  loopPacket.writeUInt16BE(0xc00c, 12); // pointer to offset 12 (self-loop!)
  assert.deepEqual(parseMdnsPacket(loopPacket), []);

  // 已知节点匹配：命中正确 Hub、忽略陌生 Hub、拦截伪造 fp 的节点
  const known: KnownHub[] = [{
    hubInstanceId: hubA.hubInstanceId,
    hubName: '公司 Mac',
    serverPubkey: 'pub',
    serverPubkeyFp: hubA.serverPubkeyFp,
    pairedAtMs: 1,
  }];
  const spoofedHub: DiscoveredAcpmHub = { ...hubA, addresses: ['192.168.1.99'], serverPubkeyFp: '0000000000000000' };
  const strangerHub: DiscoveredAcpmHub = { ...hubA, hubInstanceId: 'other-hub-uuid', serverPubkeyFp: '1111111111111111' };

  const matchResult = matchKnownHubs([hubA, spoofedHub, strangerHub], known);
  assert.equal(matchResult.matched.length, 1);
  assert.equal(matchResult.matched[0].discovered.addresses[0], '192.168.1.24');
  assert.equal(matchResult.spoofed.length, 1);
  assert.equal(matchResult.spoofed[0].discovered.addresses[0], '192.168.1.99');
  assert.equal(matchResult.unknown.length, 1);
});

test('端到端配对闭环：Mac 初始化 -> 扫码绑定 Android -> 反向扫码绑定家里 Win + Hub #2 -> 恢复码还原 (SYNC-01)', async () => {
  const macDir = mkdtempSync(join(tmpdir(), 'yanmo-sync-mac-'));
  const winDir = mkdtempSync(join(tmpdir(), 'yanmo-sync-win-'));
  const androidStoreDir = mkdtempSync(join(tmpdir(), 'yanmo-sync-android-'));

  const officeHub = createMockSyncHub({ baseURL: 'http://192.168.1.20:18790' });
  const homeHub = createMockSyncHub({ baseURL: 'http://10.0.0.50:18790' });
  officeHub.writeRuntimeJson(macDir);
  homeHub.writeRuntimeJson(winDir);

  const combinedFetch: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith(officeHub.baseURL)) return officeHub.fetchImpl(input, init);
    if (urlStr.startsWith(homeHub.baseURL)) return homeHub.fetchImpl(input, init);
    throw new TypeError(`unexpected fetch URL: ${urlStr}`);
  };

  try {
    // 1. 公司 Mac 开启同步（经本机 runtime.json 自动绑定 Hub #1）
    const macSecretStore = new MemorySyncSecretStore();
    const macService = new SyncPairingService({
      secretStore: macSecretStore,
      hubStore: new MemoryKnownHubStore(),
      dataDir: macDir,
      fetchImpl: combinedFetch,
      localAddressesProvider: () => ['192.168.1.20'],
    });
    const macStatus = await macService.enableOnLocalHub('公司 MacBook', 'macos');
    assert.equal(macStatus.enabled, true);
    assert.ok(macStatus.vaultId);
    assert.equal(macStatus.knownHubs.length, 1);

    // 2. Mac 生成邀请二维码：确保二维码中绝不含裸 root_seed
    const invite = await macService.createInvitePairing();
    const macRootSeedB64 = macSecretStore.load()!.rootSeedB64!;
    assert.equal(invite.qrUri.includes(macRootSeedB64), false);
    assert.equal(JSON.stringify(invite.qrPayload).includes(macRootSeedB64), false);

    // 伪造 Hub 指纹篡改时，Android 必须拒绝连接
    const tamperedQr = JSON.stringify({ ...invite.qrPayload, fp: 'ffffffffffffffff' });
    const androidSecretStore = new MemorySyncSecretStore();
    const androidHubStore = new FileKnownHubStore(androidStoreDir);
    const androidService = new SyncPairingService({
      secretStore: androidSecretStore,
      hubStore: androidHubStore,
      fetchImpl: combinedFetch,
      mdnsBrowser: {
        async discover() {
          return [
            {
              serviceName: 'acpm-office',
              host: 'acpm-office.local',
              addresses: ['192.168.1.20'],
              port: 18790,
              hubInstanceId: officeHub.hubInstanceId,
              serverPubkeyFp: officeHub.serverPubkeyFp,
              syncEnabled: true,
              apiPrefix: '/v1',
              txt: {},
            },
            {
              serviceName: 'acpm-home-spoof',
              host: 'evil.local',
              addresses: ['192.168.1.250'],
              port: 18790,
              hubInstanceId: homeHub.hubInstanceId,
              serverPubkeyFp: '0123456789abcdef',
              syncEnabled: true,
              apiPrefix: '/v1',
              txt: {},
            },
          ];
        },
      },
    });
    await assert.rejects(
      androidService.redeemInvitePairing(tamperedQr, 'My Android', 'android'),
      /指纹|不一致|FINGERPRINT/,
    );

    // 3. Android 扫正常二维码：一次性打通 Hub #1 推理 + 同步，并验证双方空间密钥完全一致
    const androidStatus = await androidService.redeemInvitePairing(invite.qrUri, 'My Android', 'android');
    assert.equal(androidStatus.enabled, true);
    assert.equal(androidStatus.vaultId, macStatus.vaultId);
    assert.equal(androidStatus.knownHubs.length, 1);

    // 一次性信箱用后即焚：再次兑换同一二维码必须失败
    await assert.rejects(
      androidService.redeemInvitePairing(invite.qrUri, 'Rogue Device', 'android'),
      (err: unknown) => err instanceof AcpmError && err.httpStatus === 404,
    );

    // 4. 连续 5 次输错配对码，会话自动作废
    const invite2 = await macService.createInvitePairing();
    for (let attempt = 0; attempt < 5; attempt++) {
      const wrongQr = JSON.stringify({ ...invite2.qrPayload, code: '00000000' });
      await assert.rejects(
        new SyncPairingService({
          secretStore: new MemorySyncSecretStore(),
          hubStore: new MemoryKnownHubStore(),
          fetchImpl: combinedFetch,
        }).redeemInvitePairing(wrongQr, 'Bad Device', 'android'),
      );
    }
    await assert.rejects(
      new SyncPairingService({
        secretStore: new MemorySyncSecretStore(),
        hubStore: new MemoryKnownHubStore(),
        fetchImpl: combinedFetch,
      }).redeemInvitePairing(invite2.qrUri, 'Late Device', 'android'),
      (err: unknown) => err instanceof AcpmError && err.httpStatus === 404,
    );

    // 5. 多 Hub 场景：家里 Win + Hub #2 等待手机反向扫码加入
    const winSecretStore = new MemorySyncSecretStore();
    const winService = new SyncPairingService({
      secretStore: winSecretStore,
      hubStore: new MemoryKnownHubStore(),
      dataDir: winDir,
      fetchImpl: combinedFetch,
      localAddressesProvider: () => ['10.0.0.50'],
    });
    const joinWait = await winService.createJoinWaitPairing();
    assert.equal(parsePairingQr(joinWait.qrUri).mode, 'join_wait');

    // Android 扫码：先把自己注册到 Hub #2 并把 Hub #2 记入 knownHubs，再用 X25519 ECDH 投递加密的 root_seed
    const androidAfterHome = await androidService.fulfillJoinWaitAsExistingDevice(joinWait.qrUri, 'My Android', 'android');
    assert.equal(androidAfterHome.knownHubs.length, 2);

    // 家里 Win 取回密文信箱并完成本机 Hub #2 注册
    const winStatus = await winService.completeJoinWaitOnNewDevice(joinWait.sessionId, '家里 Win', 'windows');
    assert.equal(winStatus.enabled, true);
    assert.equal(winStatus.vaultId, macStatus.vaultId);
    assert.equal(winStatus.knownHubs.length, 1);

    // 验证 Mac / Android / Win 三端派生的 dataEncKey 完全相同且可互解密文
    const macKeys = deriveSpaceKeys(Buffer.from(macSecretStore.load()!.rootSeedB64!, 'base64url'));
    const androidKeys = deriveSpaceKeys(Buffer.from(androidSecretStore.load()!.rootSeedB64!, 'base64url'));
    const winKeys = deriveSpaceKeys(Buffer.from(winSecretStore.load()!.rootSeedB64!, 'base64url'));
    assert.deepEqual(androidKeys.dataEncKey, macKeys.dataEncKey);
    assert.deepEqual(winKeys.dataEncKey, macKeys.dataEncKey);

    const aad = recordAad(macKeys.vaultId, 'manuscript', 'm-1', '01795584812345-0000-mac', false);
    const cipher = sealEnvelope(macKeys.dataEncKey, Buffer.from('言墨跨端密文测试'), aad);
    assert.equal(openEnvelope(winKeys.dataEncKey, cipher, aad).toString('utf8'), '言墨跨端密文测试');

    // 6. Android mDNS 发现已知 Hub（验证屏蔽伪造的 Home Hub）
    const discResult = await androidService.discoverKnownHubs();
    assert.equal(discResult.matched.length, 1);
    assert.equal(discResult.matched[0].hubInstanceId, officeHub.hubInstanceId);
    assert.deepEqual(discResult.spoofedHubIds, [homeHub.hubInstanceId]);

    // 7. 设备管理与吊销：Mac 列出设备并吊销后再查
    const devices = await macService.listDevices();
    assert.equal(devices.length, 2); // Mac + Android on Office Hub
    const revoked = await macService.revokeDevice(androidStatus.deviceId);
    assert.equal(revoked.device_id, androidStatus.deviceId);
    assert.ok(revoked.revoked_at_ms > 0);

    // 8. 恢复码导出与全新设备恢复
    const recoveryCode = macService.exportRecoveryCode();
    const restoredSecretStore = new MemorySyncSecretStore();
    const restoredService = new SyncPairingService({
      secretStore: restoredSecretStore,
      hubStore: new MemoryKnownHubStore(),
      fetchImpl: combinedFetch,
    });
    const restoredStatus = await restoredService.restoreFromRecoveryCode(recoveryCode, 'Restored Mac', 'macos', { registerLocal: false });
    assert.equal(restoredStatus.enabled, true);
    assert.equal(restoredStatus.vaultId, macStatus.vaultId);
    assert.equal(computePubkeyFingerprint(deriveSpaceKeys(Buffer.from(restoredSecretStore.load()!.rootSeedB64!, 'base64url')).ownerPublicKeyRaw),
      computePubkeyFingerprint(macKeys.ownerPublicKeyRaw));
  } finally {
    rmSync(macDir, { recursive: true, force: true });
    rmSync(winDir, { recursive: true, force: true });
    rmSync(androidStoreDir, { recursive: true, force: true });
  }
});

test('安全边界与多 Hub 管理回归测试 (H1 / H4 / H5 / M5 / L8)', async () => {
  const hub1Dir = mkdtempSync(join(tmpdir(), 'yanmo-reg1-h1-'));
  const hub2Dir = mkdtempSync(join(tmpdir(), 'yanmo-reg1-h2-'));
  const hub1 = createMockSyncHub({ baseURL: 'http://192.168.1.20:18790' });
  const hub2 = createMockSyncHub({ baseURL: 'http://10.0.0.50:18790' });
  const combinedFetch: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith(hub1.baseURL)) return hub1.fetchImpl(input, init);
    if (urlStr.startsWith(hub2.baseURL)) return hub2.fetchImpl(input, init);
    throw new TypeError(`unexpected URL: ${urlStr}`);
  };
  hub1.writeRuntimeJson(hub1Dir);
  hub2.writeRuntimeJson(hub2Dir);

  try {
    // H5: getStatus() 在空密钥存储上严格只读，不产生写入
    let saveCalls = 0;
    const spyingStore = new MemorySyncSecretStore();
    const origSave = spyingStore.save.bind(spyingStore);
    spyingStore.save = (rec) => {
      saveCalls += 1;
      origSave(rec);
    };
    const roPairing = new SyncPairingService({
      secretStore: spyingStore,
      hubStore: new MemoryKnownHubStore(),
      fetchImpl: combinedFetch,
    });
    const emptyStatus = roPairing.getStatus();
    assert.equal(emptyStatus.enabled, false);
    assert.equal(emptyStatus.deviceId, '');
    assert.equal(saveCalls, 0);

    // H1: PoP 响应缺少服务端签名时客户端强制拒绝
    const devA = new SyncPairingService({
      secretStore: new MemorySyncSecretStore(),
      hubStore: new MemoryKnownHubStore(),
      dataDir: hub1Dir,
      fetchImpl: combinedFetch,
      localAddressesProvider: () => ['192.168.1.20'],
    });
    await devA.enableOnLocalHub('Mac-A', 'macos');

    const bSecretStore = new MemorySyncSecretStore();
    const devB = new SyncPairingService({
      secretStore: bSecretStore,
      hubStore: new MemoryKnownHubStore(),
      dataDir: hub2Dir,
      fetchImpl: combinedFetch,
      localAddressesProvider: () => ['192.168.1.20'],
    });
    const inv = await devA.createInvitePairing({ advertiseAddrs: ['192.168.1.20'] });
    await devB.redeemInvitePairing(inv.qrUri, 'Android-B', 'android');

    const bHubs = devB.getStatus().knownHubs;
    const popClient = new AcpmClient({
      mode: 'remote',
      remoteBaseURL: hub1.baseURL,
      popAuth: {
        deviceId: devB.getStatus().deviceId,
        privateSeed: Buffer.from(bSecretStore.load()!.devicePrivateSeedB64, 'base64url'),
        serverPubkey: hub1.serverPubkey,
        expectedServerPubkeyFp: bHubs[0].serverPubkeyFp,
      },
      fetchImpl: combinedFetch,
    });
    hub1.stripNextServerSignature();
    await assert.rejects(
      popClient.models(),
      (err: unknown) => err instanceof AcpmError && err.code === 'FORBIDDEN',
    );

    // M5: 指定不存在的 hubId 不得回退本地节点；不传 hubId 时跨所有已知 Hub 吊销设备
    const winJoin = await devB.createJoinWaitPairing();
    // 让 hub2 上也注册同一个 Android-B 设备（模拟漫游多 Hub 后吊销 Android-B）
    const devAOnHub2 = new SyncPairingService({
      secretStore: new MemorySyncSecretStore(),
      hubStore: new MemoryKnownHubStore(),
      dataDir: hub1Dir,
      fetchImpl: combinedFetch,
      localAddressesProvider: () => ['192.168.1.20'],
    });
    await devAOnHub2.restoreFromRecoveryCode(devA.exportRecoveryCode(), 'Helper', 'macos', { registerLocal: false });
    const jw = await new SyncPairingService({
      secretStore: new MemorySyncSecretStore(),
      hubStore: new MemoryKnownHubStore(),
      dataDir: hub2Dir,
      fetchImpl: combinedFetch,
      localAddressesProvider: () => ['10.0.0.50'],
    }).createJoinWaitPairing();
    await devB.fulfillJoinWaitAsExistingDevice(jw.qrUri, 'Android-B', 'android');
    assert.equal(devB.getStatus().knownHubs.length, 2);

    // 将 hub2 也记入 devA 的 knownHubs，测试从 devA 一次吊销同时作用于 hub1 与 hub2
    const jw2 = await new SyncPairingService({
      secretStore: new MemorySyncSecretStore(),
      hubStore: new MemoryKnownHubStore(),
      dataDir: hub2Dir,
      fetchImpl: combinedFetch,
      localAddressesProvider: () => ['10.0.0.50'],
    }).createJoinWaitPairing();
    await devA.fulfillJoinWaitAsExistingDevice(jw2.qrUri, 'Mac-A', 'macos');

    await assert.rejects(devA.revokeDevice(devB.getStatus().deviceId, 'unknown-hub-id'), /未找到指定/);
    await devA.revokeDevice(devB.getStatus().deviceId);
    assert.ok(hub1.pairedDevices.get(devB.getStatus().deviceId)?.revoked_at_ms);
    assert.ok(hub2.pairedDevices.get(devB.getStatus().deviceId)?.revoked_at_ms);

    // H4: 已绑定空间的设备未确认前拒绝静默切换到另一个恢复码空间；确认后可切换并重置已知节点
    const otherCode = encodeRecoveryCode(generateRootSeed());
    await assert.rejects(
      devA.restoreFromRecoveryCode(otherCode, 'Mac-A', 'macos', { registerLocal: false }),
      /切换/,
    );
    const switched = await devA.restoreFromRecoveryCode(otherCode, 'Mac-A', 'macos', {
      registerLocal: false,
      allowReplaceSpace: true,
    });
    assert.equal(switched.knownHubs.length, 0);

    // L8: IPv6 字面量地址自动加方括号
    const ipv6Url = resolveHubBaseUrl(
      {
        hubInstanceId: 'h-v6',
        hubName: 'v6',
        serverPubkey: 'pub',
        serverPubkeyFp: '0123456789abcdef',
        pairedAtMs: 1,
      },
      {
        discovered: {
          serviceName: 'acpm-v6',
          host: 'fe80::1',
          addresses: ['::1'],
          port: 18790,
          hubInstanceId: 'h-v6',
          serverPubkeyFp: '0123456789abcdef',
          syncEnabled: true,
          apiPrefix: '/v1',
          txt: {},
        },
      },
    );
    assert.equal(ipv6Url, 'http://[::1]:18790');
    assert.ok(winJoin.sessionId);
  } finally {
    rmSync(hub1Dir, { recursive: true, force: true });
    rmSync(hub2Dir, { recursive: true, force: true });
  }
});
