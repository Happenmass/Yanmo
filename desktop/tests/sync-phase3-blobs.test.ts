import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpmClient } from '../acpm';
import { cocoaNow, defaultSettings, type Manuscript } from '../shared';
import { LibraryStore } from '../store';
import { computeBlobId, deriveSpaceKeys, signPopHeaders } from '../sync-crypto';
import { decryptSyncBlob, encryptSyncBlob, SyncEngine } from '../sync-engine';
import {
  MemoryKnownHubStore,
  MemorySyncSecretStore,
  SyncPairingService,
} from '../sync-pairing';
import { createMockSyncHub } from './sync-hub-mock';

function createNodeEnv(prefix: string, nowFn: () => number, fetchImpl: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = new LibraryStore(dir, defaultSettings());
  const secretStore = new MemorySyncSecretStore();
  const hubStore = new MemoryKnownHubStore();
  const pairing = new SyncPairingService({
    secretStore,
    hubStore,
    dataDir: dir,
    fetchImpl,
    localAddressesProvider: () => ['192.168.1.20'],
  });
  const engine = new SyncEngine({
    store,
    secretStore,
    hubStore,
    dataDir: dir,
    fetchImpl,
    nowFn,
  });
  return {
    dir,
    store,
    secretStore,
    hubStore,
    pairing,
    engine,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('encryptSyncBlob / decryptSyncBlob 往返加解密与 AAD 篡改拦截', () => {
  const space = deriveSpaceKeys(Buffer.alloc(32, 9));
  const raw = Buffer.from('fLaC\x00\x00\x00\x22synthetic-audio-stream');
  const blobId = computeBlobId(space.keyMacKey, createHash('sha256').update(raw).digest('hex'));
  const sealed = encryptSyncBlob(space.dataEncKey, space.vaultId, blobId, raw);

  assert.equal(sealed.includes('fLaC'), false);
  assert.deepEqual(decryptSyncBlob(space.dataEncKey, space.vaultId, blobId, sealed), raw);
  assert.throws(() => decryptSyncBlob(space.dataEncKey, space.vaultId, '0'.repeat(64), sealed));
});

test('大附件密文上传秒传去重、按需拉取缓存与 inference-only 权限隔离', async () => {
  let simTime = Date.now();
  const nowFn = () => {
    simTime += 50;
    return simTime;
  };
  const hub = createMockSyncHub({ nowMs: nowFn });
  const mac = createNodeEnv('yanmo-p3-mac-', nowFn, hub.fetchImpl);
  const android = createNodeEnv('yanmo-p3-and-', nowFn, hub.fetchImpl);
  const colleague = createNodeEnv('yanmo-p3-col-', nowFn, hub.fetchImpl);
  hub.writeRuntimeJson(mac.dir);

  try {
    await mac.pairing.enableOnLocalHub('Mac', 'macos');
    const invite = await mac.pairing.createInvitePairing({ advertiseAddrs: ['192.168.1.20'] });
    await android.pairing.redeemInvitePairing(invite.qrUri, 'Android', 'android');

    const infInvite = await mac.pairing.createInvitePairing({ scopes: ['inference'], advertiseAddrs: ['192.168.1.20'] });
    await colleague.pairing.redeemInvitePairing(infInvite.qrUri, 'Colleague', 'android');

    mac.engine.ensureConfigured();
    android.engine.ensureConfigured();

    const audioBytes = Buffer.from('fLaC-synthetic-recording-payload-123456');
    const screenshotBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const item: Manuscript = {
      id: 'm-blob-1',
      date: cocoaNow(),
      recordingEndedAtMs: simTime,
      original: '带录音和截屏的口述',
      text: '带录音和截屏的整理正文。',
      seconds: 4.5,
      application: '备忘录',
      polished: true,
    };
    mac.store.library.manuscripts.push(item);
    mac.store.persist({ id: item.id, audioOpus: audioBytes, screenshotImage: screenshotBytes });

    // 1. 启用 uploadBlobs 同步：上传密文并推元数据
    const syncRes = await mac.engine.syncWithHub(hub.hubInstanceId, undefined, { uploadBlobs: true });
    assert.equal(syncRes.appliedRemote, 1);
    assert.equal(hub.syncBlobs.size, 2);

    // 验证 Hub 上存储的均为密文（不含明文 fLaC 或 JPEG 头）
    for (const storedBlob of hub.syncBlobs.values()) {
      assert.equal(storedBlob.subarray(0, 4).toString('ascii') === 'fLaC', false);
      assert.equal(storedBlob[0] === 0xff && storedBlob[1] === 0xd8, false);
    }

    // 2. 二次上传通过 HEAD 检查走秒传跳过
    const dedup = await mac.engine.uploadManuscriptBlobs(item.id, hub.hubInstanceId);
    assert.equal(dedup.uploaded.length, 0);
    assert.equal(dedup.skipped.length, 2);

    // 3. Android 仅同步正文元数据：此时本机尚无大附件
    await android.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(android.store.library.manuscripts.length, 1);
    assert.deepEqual(android.store.getAttachments(item.id), {});

    // 4. 按需拉取并缓存至本地 SQLite（不推进本地 HLC）
    const hlcBefore = android.store.getSyncEntry('manuscript', item.id)!.versionHlc;
    const fetched = await android.engine.ensureManuscriptAttachments(item.id, hub.hubInstanceId);
    assert.deepEqual(Buffer.from(fetched.audio!), audioBytes);
    assert.deepEqual(Buffer.from(fetched.screenshot!), screenshotBytes);
    assert.equal(android.store.getSyncEntry('manuscript', item.id)!.versionHlc, hlcBefore);
    assert.equal(android.store.library.manuscripts[0].hasAudio, true);

    // 本地已缓存后再次读取不触发网络请求
    const cached = await android.engine.ensureManuscriptAttachments(item.id, 'nonexistent-hub');
    assert.deepEqual(Buffer.from(cached.audio!), audioBytes);
    assert.deepEqual(Buffer.from(cached.screenshot!), screenshotBytes);

    // 5. 仅 inference 权限的设备禁止访问 blobs 接口 (403 FORBIDDEN)
    const colSecrets = colleague.secretStore.load()!;
    const macSecrets = mac.secretStore.load()!;
    const vaultId = deriveSpaceKeys(Buffer.from(macSecrets.rootSeedB64!, 'base64url')).vaultId;
    const [anyBlobKey] = hub.syncBlobs.keys();
    const blobId = anyBlobKey.split(':')[1];
    const blobPath = `/v1/sync/vaults/${vaultId}/blobs/${blobId}`;
    const colClient = new AcpmClient({
      mode: 'remote',
      remoteBaseURL: hub.baseURL,
      popAuth: {
        deviceId: colSecrets.deviceId,
        privateSeed: Buffer.from(colSecrets.devicePrivateSeedB64, 'base64url'),
        serverPubkey: hub.serverPubkey,
      },
      fetchImpl: hub.fetchImpl,
    });
    await assert.rejects(
      colClient.downloadSyncBlob(vaultId, blobId),
      err => (err as { httpStatus?: number }).httpStatus === 403,
    );
    const colHead = await hub.fetchImpl(`${hub.baseURL}${blobPath}`, {
      method: 'HEAD',
      headers: signPopHeaders(colSecrets.deviceId, Buffer.from(colSecrets.devicePrivateSeedB64, 'base64url'), 'HEAD', blobPath),
    });
    assert.equal(colHead.status, 403);

    // 6. L3: 先同步纯元数据，后续缓存附件并上传生成 blob ref 时，必须推进 version_hlc 并重推到 Hub
    const item2: Manuscript = {
      id: 'm-blob-later',
      date: cocoaNow(),
      recordingEndedAtMs: simTime,
      original: '先文字后附件',
      text: '先文字后附件。',
      seconds: 2.0,
      application: '备忘录',
      polished: true,
    };
    mac.store.library.manuscripts.push(item2);
    mac.store.persist();
    await mac.engine.syncWithHub(hub.hubInstanceId);
    const hlcBeforeBlobUpload = mac.store.getSyncEntry('manuscript', item2.id)!.versionHlc;

    mac.store.saveCachedAttachments(item2.id, { audioOpus: audioBytes });
    await mac.engine.uploadManuscriptBlobs(item2.id, hub.hubInstanceId);
    const hlcAfterBlobUpload = mac.store.getSyncEntry('manuscript', item2.id)!.versionHlc;
    assert.ok(hlcAfterBlobUpload > hlcBeforeBlobUpload);

    await mac.engine.syncWithHub(hub.hubInstanceId);
    await android.engine.syncWithHub(hub.hubInstanceId);
    assert.ok((android.store.getSyncEntry('manuscript', item2.id)?.meta.audioBlob as { blob_id?: string } | undefined)?.blob_id);
  } finally {
    mac.cleanup();
    android.cleanup();
    colleague.cleanup();
  }
});
