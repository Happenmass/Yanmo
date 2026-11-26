import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cocoaNow, defaultSettings, type Manuscript } from '../shared';
import { LibraryStore } from '../store';
import { computeLexiconRecordKey, deriveSpaceKeys } from '../sync-crypto';
import {
  decryptSyncRecord,
  encryptSyncRecord,
  mergeLexiconState,
  SyncEngine,
  type LexiconSyncPayload,
} from '../sync-engine';
import { compareHlc, formatHlc, HlcClock, parseHlc } from '../sync-hlc';
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

test('HLC 定长格式、字典序全序、计数器进位与远端超前时钟钳位', () => {
  let clockMs = 1_795_584_812_345;
  const clock = new HlcClock('dev-a', {}, () => clockMs);
  const h1 = clock.tick();
  const h2 = clock.tick();
  assert.match(h1, /^\d{14}-[0-9a-f]{4}-dev-a$/);
  assert.equal(compareHlc(h1, h2), -1);
  assert.equal(parseHlc(h2).counter, 1);

  // 计数器溢出进位
  const edge = new HlcClock('dev-a', { lastMs: clockMs, counter: 0xffff }, () => clockMs);
  const hEdge = edge.tick();
  assert.equal(parseHlc(hEdge).ms, clockMs + 1);
  assert.equal(parseHlc(hEdge).counter, 0);

  // 远端超前超过 5 分钟时钳位至 now + 300_000
  const farFuture = formatHlc(clockMs + 3_600_000, 9, 'dev-b');
  const recv = clock.receive(farFuture);
  assert.equal(recv.driftClamped, true);
  assert.equal(parseHlc(recv.hlc).ms, clockMs + 300_000);
});

test('多 Hub 漫游双向收敛、零乒乓死循环与盲密文仓验证 (SYNC-02 / SYNC-03)', async () => {
  let simTime = Date.now();
  const nowFn = () => {
    simTime += 50;
    return simTime;
  };

  const officeHub = createMockSyncHub({ baseURL: 'http://192.168.1.20:18790', nowMs: nowFn });
  const homeHub = createMockSyncHub({ baseURL: 'http://10.0.0.50:18790', nowMs: nowFn });
  const fetchImpl: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith(officeHub.baseURL)) return officeHub.fetchImpl(input, init);
    if (urlStr.startsWith(homeHub.baseURL)) return homeHub.fetchImpl(input, init);
    throw new TypeError(`unexpected URL: ${urlStr}`);
  };

  const mac = createNodeEnv('yanmo-p2-mac-', nowFn, fetchImpl);
  const android = createNodeEnv('yanmo-p2-android-', nowFn, fetchImpl);
  const win = createNodeEnv('yanmo-p2-win-', nowFn, fetchImpl);
  officeHub.writeRuntimeJson(mac.dir);
  homeHub.writeRuntimeJson(win.dir);

  try {
    // 1. 配对三端与两个 Hub
    await mac.pairing.enableOnLocalHub('Office Mac', 'macos');
    const invite = await mac.pairing.createInvitePairing({ advertiseAddrs: ['192.168.1.20'] });
    await android.pairing.redeemInvitePairing(invite.qrUri, 'Pixel', 'android');

    const joinWait = await win.pairing.createJoinWaitPairing({ advertiseAddrs: ['10.0.0.50'] });
    await android.pairing.fulfillJoinWaitAsExistingDevice(joinWait.qrUri, 'Pixel', 'android');
    await win.pairing.completeJoinWaitOnNewDevice(joinWait.sessionId, 'Home Win', 'windows');

    // 2. Mac 产生一条文稿与一个词条，推到 Office Hub
    const macItem: Manuscript = {
      id: 'm-mac-1',
      date: cocoaNow(),
      original: '今天下午三点开会',
      text: '今天 15:00 开会。',
      seconds: 3.2,
      application: '飞书',
      polished: true,
    };
    mac.store.library.manuscripts.push(macItem);
    mac.store.library.lexicon.push({ id: 't-mac-1', term: '言墨', hint: '语音输入法', aliases: ['Yanmo'], group: 'global', createdAt: simTime });
    mac.store.persist();
    const sMac1 = await mac.engine.syncWithHub(officeHub.hubInstanceId);
    assert.equal(sMac1.appliedRemote, 2);

    // 3. Win 在家产生一条文稿，推到 Home Hub
    const winItem: Manuscript = {
      id: 'm-win-1',
      date: cocoaNow(),
      original: '晚上记得提交代码',
      text: '晚上记得提交代码。',
      seconds: 2.5,
      application: 'VS Code',
      polished: true,
    };
    win.store.library.manuscripts.push(winItem);
    win.store.persist();
    const sWin1 = await win.engine.syncWithHub(homeHub.hubInstanceId);
    assert.equal(sWin1.appliedRemote, 1);

    // 4. Android 漫游：先在公司同步 Office Hub，再回家同步 Home Hub，然后回公司同步 Office Hub
    await android.engine.syncWithHub(officeHub.hubInstanceId);
    assert.equal(android.store.library.manuscripts.length, 1);
    assert.equal(android.store.library.lexicon.length, 1);

    await android.engine.syncWithHub(homeHub.hubInstanceId);
    assert.equal(android.store.library.manuscripts.length, 2);

    await android.engine.syncWithHub(officeHub.hubInstanceId);
    await mac.engine.syncWithHub(officeHub.hubInstanceId);
    await win.engine.syncWithHub(homeHub.hubInstanceId);

    // 三端完全收敛
    assert.equal(mac.store.library.manuscripts.length, 2);
    assert.equal(win.store.library.manuscripts.length, 2);
    assert.equal(win.store.library.lexicon[0].term, '言墨');

    // 5. 零乒乓验证：继续在两台 Hub 上重复同步，seq 不再增长
    const officeSeqBefore = officeHub.getLatestSeq();
    const homeSeqBefore = homeHub.getLatestSeq();
    const macIdle = await mac.engine.syncWithHub(officeHub.hubInstanceId);
    const androidIdleOffice = await android.engine.syncWithHub(officeHub.hubInstanceId);
    const androidIdleHome = await android.engine.syncWithHub(homeHub.hubInstanceId);
    const winIdle = await win.engine.syncWithHub(homeHub.hubInstanceId);
    assert.equal(macIdle.pushed, 0);
    assert.equal(androidIdleOffice.pushed, 0);
    assert.equal(androidIdleHome.pushed, 0);
    assert.equal(winIdle.pushed, 0);
    assert.equal(officeHub.getLatestSeq(), officeSeqBefore);
    assert.equal(homeHub.getLatestSeq(), homeSeqBefore);

    // 6. 盲密文仓验证 (SYNC-03)：Hub 上不出现任何明文敏感词
    for (const rec of [...officeHub.syncRecords.values(), ...homeHub.syncRecords.values()]) {
      const raw = JSON.stringify(rec);
      assert.equal(raw.includes('今天 15:00 开会'), false);
      assert.equal(raw.includes('晚上记得提交代码'), false);
      assert.equal(raw.includes('飞书'), false);
      assert.equal(raw.includes('VS Code'), false);
      assert.equal(raw.includes('言墨'), false);
      assert.equal(raw.includes('Yanmo'), false);
    }
  } finally {
    mac.cleanup();
    android.cleanup();
    win.cleanup();
  }
});

test('并发词库去重、别名合并/删别名不复活、分桶计数累加与词条改名 (SYNC-04)', async () => {
  let simTime = Date.now();
  const nowFn = () => {
    simTime += 100;
    return simTime;
  };
  const hub = createMockSyncHub({ nowMs: nowFn });
  const mac = createNodeEnv('yanmo-lex-mac-', nowFn, hub.fetchImpl);
  const android = createNodeEnv('yanmo-lex-and-', nowFn, hub.fetchImpl);
  hub.writeRuntimeJson(mac.dir);

  try {
    await mac.pairing.enableOnLocalHub('Mac', 'macos');
    const invite = await mac.pairing.createInvitePairing({ advertiseAddrs: ['192.168.1.20'] });
    await android.pairing.redeemInvitePairing(invite.qrUri, 'Android', 'android');

    // 两端先各自配置同步，离线并发添加同名（不同全半角/空格/大小写）词条，并各自累加不同命中次数与别名
    mac.engine.ensureConfigured();
    android.engine.ensureConfigured();

    mac.store.library.lexicon.push({
      id: 'mac-term-1',
      term: '  ＡｃｐｍRuntime ',
      hint: '旧备注',
      aliases: ['acpm', 'acmp'],
      group: 'ai_tools',
      matchCount: 3,
      lastMatchedAt: simTime,
      createdAt: simTime - 5000,
    });
    mac.store.persist();

    android.store.library.lexicon.push({
      id: 'and-term-1',
      term: 'AcpmRuntime',
      hint: '本地推理中转服务',
      aliases: ['acpm runtime'],
      group: 'ai_tools',
      matchCount: 5,
      lastMatchedAt: simTime + 100,
      createdAt: simTime - 1000,
    });
    android.store.persist();

    // 同步收敛
    await mac.engine.syncWithHub(hub.hubInstanceId);
    await android.engine.syncWithHub(hub.hubInstanceId);
    await mac.engine.syncWithHub(hub.hubInstanceId);

    assert.equal(mac.store.library.lexicon.length, 1);
    assert.equal(android.store.library.lexicon.length, 1);
    assert.equal(mac.store.library.lexicon[0].matchCount, 8);
    assert.equal(android.store.library.lexicon[0].matchCount, 8);
    assert.equal(android.store.library.lexicon[0].hint, '本地推理中转服务');
    assert.deepEqual(
      new Set(mac.store.library.lexicon[0].aliases),
      new Set(['acpm', 'acmp', 'acpm runtime']),
    );

    // Mac 删除别名 'acmp'，同步后 Android 也不应再保留 'acmp'
    mac.store.library.lexicon[0].aliases = mac.store.library.lexicon[0].aliases!.filter(a => a !== 'acmp');
    mac.store.persist();
    await mac.engine.syncWithHub(hub.hubInstanceId);
    await android.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(android.store.library.lexicon[0].aliases!.includes('acmp'), false);

    // Mac 将词条改名为 'AcpmDesktop'：旧记录产生墓碑，新词条新增
    mac.store.library.lexicon[0].term = 'AcpmDesktop';
    mac.store.persist();
    await mac.engine.syncWithHub(hub.hubInstanceId);
    await android.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(android.store.library.lexicon.length, 1);
    assert.equal(android.store.library.lexicon[0].term, 'AcpmDesktop');
  } finally {
    mac.cleanup();
    android.cleanup();
  }
});

test('离线删除不复活、删除后重加恢复，以及本地保留期清理不误删他端 (SYNC-05 / SYNC-08)', async () => {
  let simTime = Date.now();
  const nowFn = () => {
    simTime += 100;
    return simTime;
  };
  const hub = createMockSyncHub({ nowMs: nowFn });
  const mac = createNodeEnv('yanmo-del-mac-', nowFn, hub.fetchImpl);
  const android = createNodeEnv('yanmo-del-and-', nowFn, hub.fetchImpl);
  hub.writeRuntimeJson(mac.dir);

  try {
    await mac.pairing.enableOnLocalHub('Mac', 'macos');
    const invite = await mac.pairing.createInvitePairing({ advertiseAddrs: ['192.168.1.20'] });
    await android.pairing.redeemInvitePairing(invite.qrUri, 'Android', 'android');
    mac.engine.ensureConfigured();
    android.engine.ensureConfigured();

    // 初始共有两篇文稿与一个词条
    const oldDate = cocoaNow() - 5 * 86400;
    mac.store.library.manuscripts.push(
      { id: 'm-keep', date: cocoaNow(), original: '保留', text: '保留文稿', seconds: 1, application: '备忘录', polished: false },
      { id: 'm-old', date: oldDate, original: '五天前', text: '五天前文稿', seconds: 2, application: '微信', polished: true },
    );
    mac.store.library.lexicon.push({ id: 't-1', term: '千问', hint: '', aliases: [], group: 'global' });
    mac.store.persist();
    await mac.engine.syncWithHub(hub.hubInstanceId);
    await android.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(android.store.library.manuscripts.length, 2);

    // 1. SYNC-05：Android 离线删除 m-keep 与词条 t-1 并推送，Mac 上线同步后不复活
    android.store.library.manuscripts = android.store.library.manuscripts.filter(m => m.id !== 'm-keep');
    android.store.library.lexicon = [];
    android.store.persist();
    await android.engine.syncWithHub(hub.hubInstanceId);

    await mac.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(mac.store.library.manuscripts.some(m => m.id === 'm-keep'), false);
    assert.equal(mac.store.library.lexicon.length, 0);

    // 再次同步也不会复活
    await android.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(android.store.library.manuscripts.some(m => m.id === 'm-keep'), false);

    // 删除词条后以更高 HLC 重新添加同名同 key 词条可恢复
    mac.store.library.lexicon.push({ id: 't-1-readded', term: '千问', hint: '重新加入', aliases: [] });
    mac.store.persist();
    await mac.engine.syncWithHub(hub.hubInstanceId);
    await android.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(android.store.library.lexicon.length, 1);
    assert.equal(android.store.library.lexicon[0].hint, '重新加入');

    // 2. SYNC-08：Android 设置本地保留期 1 天并执行 prune()，不得误删 Mac 上的 m-old
    android.store.settings.retention = 1;
    android.store.prune();
    android.store.persist();
    assert.equal(android.store.library.manuscripts.some(m => m.id === 'm-old'), false);

    await android.engine.syncWithHub(hub.hubInstanceId);
    await mac.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(mac.store.library.manuscripts.some(m => m.id === 'm-old'), true);

    // 且 Android 再次拉取旧版本 m-old 时不会本地复活，但若 Mac 之后主动编辑 m-old（更高 HLC），Android 重新可见
    await android.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(android.store.library.manuscripts.some(m => m.id === 'm-old'), false);

    // 3. 90 天墓碑 GC 校验
    const purged = mac.store.gcExpiredTombstones(90 * 86_400 * 1000, simTime + 100 * 86_400 * 1000);
    assert.ok(purged >= 1);
  } finally {
    mac.cleanup();
    android.cleanup();
  }
});

test('并发回调、分组去重、计数不复活与异常记录隔离回归测试 (C1 / H2 / H3 / H4 / M2 / M3 / M4 / M10)', async () => {
  let simTime = Date.now();
  const nowFn = () => {
    simTime += 50;
    return simTime;
  };
  const hub = createMockSyncHub({ nowMs: nowFn });
  const mac = createNodeEnv('yanmo-reg-mac-', nowFn, hub.fetchImpl);
  const android = createNodeEnv('yanmo-reg-and-', nowFn, hub.fetchImpl);
  hub.writeRuntimeJson(mac.dir);

  try {
    await mac.pairing.enableOnLocalHub('Mac', 'macos');
    const invite = await mac.pairing.createInvitePairing({ advertiseAddrs: ['192.168.1.20'] });
    await android.pairing.redeemInvitePairing(invite.qrUri, 'Android', 'android');

    // C1: 同步拉取提交后立即触发 onRemoteLibraryChanged（在 push 开始之前），且不触发 onLocalPersisted
    let observedDuringPull = false;
    let localPersistCount = 0;
    mac.store.onRemoteLibraryChanged = () => {
      observedDuringPull = mac.store.library.lexicon.some(t => t.term === 'RemoteTrigger');
    };
    mac.store.onLocalPersisted = () => {
      localPersistCount += 1;
    };
    const vBefore = mac.store.libraryVersion;

    mac.engine.ensureConfigured();
    android.engine.ensureConfigured();

    // H2: 同名热词在不同分组各自独立同步（global vs ai_tools）
    android.store.library.lexicon.push(
      { id: 'and-g', term: 'Terminal', hint: '全局终端', aliases: [], group: 'global', matchCount: 2 },
      { id: 'and-ai', term: 'Terminal', hint: 'AI 工具配置', aliases: [], group: 'ai_tools', matchCount: 4 },
      { id: 'and-rt', term: 'RemoteTrigger', hint: '', aliases: [], group: 'global' },
    );
    android.store.persist();
    await android.engine.syncWithHub(hub.hubInstanceId);

    await mac.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(observedDuringPull, true);
    assert.equal(localPersistCount, 0);
    assert.ok(mac.store.libraryVersion > vBefore);
    assert.equal(mac.store.library.lexicon.filter(t => t.term === 'Terminal').length, 2);

    // 验证本地 persist 触发 onLocalPersisted 回调（用于后台防抖同步调度）
    mac.store.library.lexicon.push({ id: 'mac-local-cb', term: 'LocalCallbackTest', hint: '', aliases: [], group: 'global' });
    mac.store.persist();
    assert.equal(localPersistCount, 1);
    mac.store.library.lexicon = mac.store.library.lexicon.filter(t => t.id !== 'mac-local-cb');
    mac.store.persist();
    await mac.engine.syncWithHub(hub.hubInstanceId);

    // H3 (1): 仅调整词库顺序不触发 pending 推送
    mac.store.library.lexicon.reverse();
    mac.store.persist();
    assert.equal(mac.store.getPendingSyncEntries(hub.hubInstanceId).length, 0);

    // H3 (2): 仅递增 matchCount 不得复活他端已删除词条；且删后重加计数清零 (L1)
    const macRt = mac.store.library.lexicon.find(t => t.term === 'RemoteTrigger')!;
    macRt.matchCount = (macRt.matchCount ?? 0) + 5;
    mac.store.persist();

    // Android 以更新时间戳删除 RemoteTrigger 并推向 Hub
    android.store.library.lexicon = android.store.library.lexicon.filter(t => t.term !== 'RemoteTrigger');
    android.store.persist();
    await android.engine.syncWithHub(hub.hubInstanceId);

    // Mac 先拉后推：RemoteTrigger 仍保持删除状态，不会因 matchCount 增量复活
    await mac.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(mac.store.library.lexicon.some(t => t.term === 'RemoteTrigger'), false);

    // 删除后重加：计数重置，不继承被删前他端累计计数
    mac.store.library.lexicon.push({ id: 'mac-rt-readd', term: 'RemoteTrigger', hint: '新加入', aliases: [] });
    mac.store.persist();
    await mac.engine.syncWithHub(hub.hubInstanceId);
    await android.engine.syncWithHub(hub.hubInstanceId);
    const readded = android.store.library.lexicon.find(t => t.term === 'RemoteTrigger')!;
    assert.equal(readded.hint, '新加入');
    assert.equal(readded.matchCount ?? 0, 0);

    // M4: 远端记录 payload.local_id 与本机另一词条 UUID 冲突时不覆盖本机原词条
    const macVault = deriveSpaceKeys(Buffer.from(mac.secretStore.load()!.rootSeedB64!, 'base64url'));
    const existingTerm = mac.store.library.lexicon[0];
    const collideRk = computeLexiconRecordKey(macVault.keyMacKey, 'CollideTerm', 'global');
    const collideHlc = formatHlc(simTime + 500, 0, 'evil-or-peer');
    const collidePayload: LexiconSyncPayload = {
      schema_version: 1,
      local_id: existingTerm.id,
      term: 'CollideTerm',
      hint: '应分配新本地 UUID',
      aliases: [],
      removed_aliases: [],
      group: 'global',
      device_counts: {},
      last_matched_at_ms: null,
      created_at_ms: null,
    };
    const nextSeqStart = hub.getLatestSeq() + 1;
    hub.syncRecords.set(`${macVault.vaultId}:lexicon:${collideRk}`, {
      vault_id: macVault.vaultId,
      seq: nextSeqStart,
      collection: 'lexicon',
      record_key: collideRk,
      version_hlc: collideHlc,
      origin_device_id: 'evil-or-peer',
      deleted: false,
      updated_at_ms: simTime,
      ciphertext: encryptSyncRecord(
        macVault.dataEncKey,
        macVault.vaultId,
        'lexicon',
        collideRk,
        collideHlc,
        false,
        collidePayload,
        'evil-or-peer',
      ),
    });

    // M3 & M10: 同一页混入未知 collection、损坏密文、超未来时钟 (> +300_000ms) 的记录均被隔离跳过
    const farFutureHlc = formatHlc(simTime + 3_600_000, 0, 'bad-clock-dev');
    const farFutureRk = computeLexiconRecordKey(macVault.keyMacKey, 'FarFutureTerm', 'global');
    hub.syncRecords.set(`${macVault.vaultId}:lexicon:${farFutureRk}`, {
      vault_id: macVault.vaultId,
      seq: nextSeqStart + 1,
      collection: 'lexicon',
      record_key: farFutureRk,
      version_hlc: farFutureHlc,
      origin_device_id: 'bad-clock-dev',
      deleted: false,
      updated_at_ms: simTime,
      ciphertext: encryptSyncRecord(
        macVault.dataEncKey,
        macVault.vaultId,
        'lexicon',
        farFutureRk,
        farFutureHlc,
        false,
        { ...collidePayload, local_id: 'ff-1', term: 'FarFutureTerm' },
        'bad-clock-dev',
      ),
    });
    hub.syncRecords.set(`${macVault.vaultId}:lexicon:corrupted-rk`, {
      vault_id: macVault.vaultId,
      seq: nextSeqStart + 2,
      collection: 'lexicon',
      record_key: 'corrupted-rk',
      version_hlc: formatHlc(simTime + 600, 0, 'bad-dev'),
      origin_device_id: 'bad-dev',
      deleted: false,
      updated_at_ms: simTime,
      ciphertext: 'not-valid-base64url-gcm',
    });

    await mac.engine.syncWithHub(hub.hubInstanceId);
    assert.equal(mac.store.library.lexicon.some(t => t.id === existingTerm.id && t.term === existingTerm.term), true);
    const collided = mac.store.library.lexicon.find(t => t.term === 'CollideTerm')!;
    assert.notEqual(collided.id, existingTerm.id);
    assert.equal(mac.store.library.lexicon.some(t => t.term === 'FarFutureTerm'), false);

    // H4: 切换到新 vaultId 时自动重置游标与同步日志
    mac.store.configureSync({
      deviceId: mac.secretStore.load()!.deviceId,
      vaultId: 'othervaultid234567234567ab',
      keyMacKey: Buffer.alloc(32, 3),
      nowFn,
    });
    assert.equal(mac.store.getHubCursor(hub.hubInstanceId).lastPulledSeq, 0);

    // M2: Hub 返回不完整的 push results 时抛出错误，不误标 acked
    const brokenEngine = new SyncEngine({
      store: android.store,
      secretStore: android.secretStore,
      hubStore: android.hubStore,
      dataDir: android.dir,
      nowFn,
      fetchImpl: async (input, init) => {
        const res = await hub.fetchImpl(input, init);
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.endsWith('/changes') && (init?.method || 'GET').toUpperCase() === 'POST') {
          return new Response(JSON.stringify({ latest_seq: hub.getLatestSeq(), results: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return res;
      },
    });
    android.store.library.lexicon.push({ id: 'and-incomplete-test', term: 'IncompletePush', hint: '', aliases: [] });
    android.store.persist();
    await assert.rejects(brokenEngine.syncWithHub(hub.hubInstanceId));
  } finally {
    mac.cleanup();
    android.cleanup();
  }
});

test('高版本密文载荷未知字段透传保留，不丢失未来版本字段', () => {
  const space = deriveSpaceKeys(Buffer.alloc(32, 7));
  const rk = computeLexiconRecordKey(space.keyMacKey, 'Yanmo');
  const hlc = formatHlc(1_795_585_100_000, 0, 'future-dev');
  const futurePayload: LexiconSyncPayload = {
    schema_version: 2,
    local_id: 'f-1',
    term: 'Yanmo',
    hint: '未来版本词条',
    aliases: [],
    removed_aliases: [],
    group: 'global',
    device_counts: { 'future-dev': 2 },
    last_matched_at_ms: null,
    created_at_ms: 1_795_585_000_000,
    future_tags: ['brand', 'pinned'],
  };

  const cipher = encryptSyncRecord(space.dataEncKey, space.vaultId, 'lexicon', rk, hlc, false, futurePayload, 'future-dev');
  const decrypted = decryptSyncRecord<LexiconSyncPayload>(space.dataEncKey, space.vaultId, {
    collection: 'lexicon',
    record_key: rk,
    version_hlc: hlc,
    deleted: false,
    ciphertext: cipher,
    origin_device_id: 'future-dev',
  });
  const merged = mergeLexiconState(
    null,
    {
      recordKey: rk,
      payload: decrypted,
      versionHlc: hlc,
      originDeviceId: 'future-dev',
      deleted: false,
      updatedAtMs: 1_795_585_100_000,
    },
    'local-dev',
    () => formatHlc(1_795_585_100_001, 0, 'local-dev'),
  );
  assert.deepEqual(merged.syncEntry.meta.unknownFields, { future_tags: ['brand', 'pinned'] });
});
