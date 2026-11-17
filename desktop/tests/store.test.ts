import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LibraryStore } from '../store';
import { cocoaNow, defaultSettings, localDayDate, localDayKey, Manuscript, shiftLocalDay } from '../shared';

const manuscript = (id = 'synthetic'): Manuscript => ({ id, date: cocoaNow(), original: '合成原文', text: '新正文', seconds: 2, application: '测试', polished: true });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'yanmo-store-regression-'));
  return { directory, close() { rmSync(directory, { recursive: true, force: true }); } };
}

function restorePreStatisticsSchema(db: DatabaseSync, version: 0 | 2) {
  db.exec(`DROP TABLE llm_usage_events; DROP TABLE app_input_events; DELETE FROM settings WHERE key='statistics_started_at_ms'; PRAGMA user_version=${version};`);
}

test('数据库提交后，陈旧或损坏的旧 JSON 不再回退正文与设置', () => {
  const f = fixture();
  try {
    const store = new LibraryStore(f.directory, defaultSettings());
    store.library.manuscripts.push(manuscript());
    store.settings.voiceTarget = 'ja'; store.persist(); store.close();
    writeFileSync(join(f.directory, 'library.json'), JSON.stringify({ manuscripts: [{ ...manuscript(), text: '旧正文' }], lexicon: [] }));
    writeFileSync(join(f.directory, 'settings.json'), 'broken');
    const reopened = new LibraryStore(f.directory, defaultSettings());
    try {
      assert.equal(reopened.error, '');
      assert.equal(reopened.library.manuscripts[0].text, '新正文');
      assert.equal(reopened.settings.voiceTarget, 'ja');
      reopened.persist();
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('首次迁移失败可重试；成功后备份 JSON，空库也不会再次导入旧历史', () => {
  const f = fixture();
  try {
    const source = join(f.directory, 'library.json');
    writeFileSync(source, 'broken');
    const broken = new LibraryStore(f.directory, defaultSettings());
    assert.ok(broken.error); assert.throws(() => broken.persist()); broken.close();
    assert.equal(readFileSync(source, 'utf8'), 'broken');
    const original = JSON.stringify({ manuscripts: [manuscript()], lexicon: [] });
    writeFileSync(source, original);
    const store = new LibraryStore(f.directory, defaultSettings());
    try {
      assert.equal(store.error, '');
      assert.equal(store.library.manuscripts.length, 1);
      assert.equal(readFileSync(source + '.migrated-backup', 'utf8'), original);
      assert.equal(existsSync(source), false);
      store.library.manuscripts = []; store.persist();
    } finally { store.close(); }
    writeFileSync(source, original);
    const empty = new LibraryStore(f.directory, defaultSettings(), source);
    try { assert.equal(empty.library.manuscripts.length, 0); } finally { empty.close(); }
  } finally { f.close(); }
});

test('文稿、音频与设置任一步失败整笔回滚，重试后一起提交', () => {
  const f = fixture();
  const store = new LibraryStore(f.directory, defaultSettings());
  const db = new DatabaseSync(store.dbPath);
  try {
    store.library.manuscripts.push(manuscript('existing')); store.persist();
    db.exec("CREATE TRIGGER fail_settings BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    const item = manuscript('new');
    const audio = { id: item.id, data: Buffer.from('OggS-synthetic') };
    store.library.manuscripts[0].text = '修改'; store.library.manuscripts.push(item);
    store.settings.voiceTarget = 'ja';
    assert.throws(() => store.persist(audio), /synthetic failure/);
    assert.equal(db.prepare('SELECT id FROM manuscripts WHERE id = ?').get(item.id), undefined);
    assert.equal(db.prepare('SELECT text FROM manuscripts WHERE id = ?').get('existing')?.text, '新正文');
    assert.equal(store.library.manuscripts[1].hasAudio, undefined);
    db.exec('DROP TRIGGER fail_settings');
    store.persist(audio);
    assert.deepEqual(store.getAudio(item.id), audio.data);
    assert.equal(store.library.manuscripts[1].hasAudio, true);
    // Editing text must preserve audio and must not rewrite unrelated rows/tables.
    db.exec("CREATE TRIGGER reject_unrelated BEFORE UPDATE ON manuscripts WHEN old.id = 'existing' BEGIN SELECT RAISE(ABORT, 'unrelated write'); END");
    db.exec("CREATE TRIGGER reject_settings BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'unrelated settings'); END");
    item.text = '只修改这一条'; store.persist();
    assert.deepEqual(store.getAudio(item.id), audio.data);
  } finally { db.close(); store.close(); f.close(); }
});


test('迁移事务中断不留下半份数据或完成标记，修复后可再次迁移', () => {
  const f = fixture();
  try {
    const initial = new LibraryStore(f.directory, defaultSettings()); initial.close();
    const db = new DatabaseSync(join(f.directory, 'yanmo.db'));
    restorePreStatisticsSchema(db, 0);
    db.exec("DELETE FROM settings; CREATE TRIGGER fail_migration BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'synthetic interruption'); END");
    const source = join(f.directory, 'library.json');
    writeFileSync(source, JSON.stringify({ manuscripts: [manuscript()], lexicon: [] }));
    const failed = new LibraryStore(f.directory, defaultSettings());
    assert.ok(failed.error); failed.close();
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM manuscripts').get()!.n, 0);
    assert.equal(existsSync(source), true);
    db.exec('DROP TRIGGER fail_migration'); db.close();
    const retry = new LibraryStore(f.directory, defaultSettings());
    try { assert.equal(retry.error, ''); assert.equal(retry.library.manuscripts.length, 1); } finally { retry.close(); }
  } finally { f.close(); }
});

test('未发布的 v0 数据库也优先于 JSON，音频随升级保留', () => {
  const f = fixture();
  try {
    const initial = new LibraryStore(f.directory, defaultSettings());
    initial.library.manuscripts.push(manuscript());
    const audio = Buffer.from('OggS-fixture');
    initial.persist({ id: 'synthetic', data: audio }); initial.close();
    const db = new DatabaseSync(join(f.directory, 'yanmo.db')); restorePreStatisticsSchema(db, 0); db.close();
    writeFileSync(join(f.directory, 'library.json'), JSON.stringify({ manuscripts: [], lexicon: [] }));
    const upgraded = new LibraryStore(f.directory, defaultSettings());
    try { assert.equal(upgraded.library.manuscripts.length, 1); assert.deepEqual(upgraded.getAudio('synthetic'), audio); } finally { upgraded.close(); }
  } finally { f.close(); }
});

test('v1 词条升级后沿用全局，写入一次命中只更新该词条且重开仍保留', () => {
  const f = fixture();
  try {
    const path = join(f.directory, 'yanmo.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE lexicon (id TEXT PRIMARY KEY, term TEXT NOT NULL, hint TEXT NOT NULL, aliases TEXT NOT NULL, position INTEGER NOT NULL);
      INSERT INTO lexicon VALUES ('old', '旧词条', '备注', '["别名"]', 0), ('other', '另一条', '', '[]', 1);
      PRAGMA user_version=1;`);
    old.close();
    const store = new LibraryStore(f.directory, defaultSettings());
    try {
      assert.equal(store.error, '');
      assert.deepEqual(store.library.lexicon[0], { id: 'old', term: '旧词条', hint: '备注', aliases: ['别名'] });
      const db = new DatabaseSync(path);
      try {
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
        db.exec("CREATE TRIGGER reject_unrelated BEFORE UPDATE ON lexicon WHEN old.id = 'other' BEGIN SELECT RAISE(ABORT, 'unrelated term'); END");
        db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON lexicon BEGIN SELECT RAISE(ABORT, 'term was rewritten'); END");
        Object.assign(store.library.lexicon[0], { group: 'ai_tools', matchCount: 2, lastMatchedAt: 1200, createdAt: 800 });
        store.persist();
      } finally { db.close(); }
    } finally { store.close(); }
    const reopened = new LibraryStore(f.directory, defaultSettings());
    try {
      assert.deepEqual(reopened.library.lexicon[0], { id: 'old', term: '旧词条', hint: '备注', aliases: ['别名'], group: 'ai_tools', matchCount: 2, lastMatchedAt: 1200, createdAt: 800 });
      assert.equal(reopened.library.lexicon[1].group, undefined);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('v2 升级保留文稿和词库，按日查询只合计已知用量及该日发送，统计独立于文稿清理', () => {
  const f = fixture();
  try {
    const initial = new LibraryStore(f.directory, defaultSettings());
    initial.library.manuscripts.push({ ...manuscript(), date: cocoaNow() - 2 * 86400 });
    initial.library.lexicon.push({ id: 'term', term: '合成词', hint: '', group: 'ai_tools', matchCount: 3 });
    initial.settings.voiceTarget = 'ja';
    initial.persist({ id: 'synthetic', data: Buffer.from('OggS-fixture') });
    initial.close();
    const path = join(f.directory, 'yanmo.db');
    const db = new DatabaseSync(path);
    restorePreStatisticsSchema(db, 2);
    const store = new LibraryStore(f.directory, defaultSettings());
    try {
      assert.equal(store.error, '');
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
      assert.deepEqual(store.getAudio('synthetic'), Buffer.from('OggS-fixture'));
      assert.equal(store.library.lexicon[0].matchCount, 3);
      assert.equal(store.settings.voiceTarget, 'ja');
      const today = localDayKey(new Date());
      const yesterday = shiftLocalDay(today, -1);
      assert.equal(store.dailyUsage(yesterday).coverage, 'unrecorded');
      const start = localDayDate(yesterday).getTime();
      const end = localDayDate(today).getTime();
      db.prepare("UPDATE settings SET value=? WHERE key='statistics_started_at_ms'").run(String(localDayDate(shiftLocalDay(yesterday, -1)).getTime()));
      const send = (eventId: string, appKey: string, characters: number, occurredAtMs: number, confirmed = false) =>
        store.recordAppInput({ eventId, appKey, appName: appKey, characters, occurredAtMs, confirmed });
      send('yesterday', 'notes', 2, start - 1);
      send('first', 'notes', 5, start);
      send('first', 'notes', 5, end, true); // confirmation must preserve the date of dispatch
      send('second', 'notes', 3, end - 1);
      send('third', 'safari', 4, start + 1);
      send('today', 'notes', 100, end);
      db.prepare("INSERT INTO llm_usage_events VALUES ('known', ?, 'polish', 'fixture', 'response', 10, 5, 15), ('unknown', ?, 'translate', 'fixture', 'request_error', NULL, NULL, NULL)").run(start, start);
      store.settings.keepHistory = false;
      store.settings.retention = 1;
      store.prune();
      store.persist();
      assert.equal(store.library.manuscripts.length, 0);
      assert.deepEqual(store.dailyUsage(yesterday), {
        coverage: 'recorded', sent: 12, previousSent: 2,
        apps: [
          { appKey: 'notes', name: 'notes', sent: 8, confirmed: 5, unverified: 3 },
          { appKey: 'safari', name: 'safari', sent: 4, confirmed: 0, unverified: 4 },
        ],
        llm: { total: 15, unknown: 1, byPurpose: { polish: 15, hotword_extract: 0, translate: null } },
      });
    } finally { db.close(); store.close(); }
    const reopened = new LibraryStore(f.directory, defaultSettings());
    try { assert.equal(reopened.dailyUsage(localDayKey(new Date())).sent, 100); }
    finally { reopened.close(); }
  } finally { f.close(); }
});
