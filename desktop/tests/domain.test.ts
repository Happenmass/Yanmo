import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cocoaNow, defaultSettings, FN_MODIFIER, migrateSettings, shortcutID, shortcutLabel, shortcutNeedsEventTap, validateSettings } from '../shared';
import { LibraryStore } from '../store';
import { decodeSSE } from '../processes';
import { renderMarkdown } from '../renderer/markdown';

test('三组 FN 默认快捷键有效且不冲突，使用明确键名', () => {
  const settings = defaultSettings();
  validateSettings(settings);
  const keys = Object.values(settings.shortcuts).flat();
  assert.deepEqual(keys.map(shortcutLabel), ['FN', 'FN + Shift', 'FN + 空格']);
  assert.ok(keys.every(shortcutNeedsEventTap));
  assert.equal(shortcutLabel({ keyCode: 0, modifiers: 6912, keyLabel: 'A' }), 'Control + Option + Command + Shift + A');
  assert.equal(shortcutLabel({ keyCode: 63, modifiers: 0, keyLabel: 'Fn' }), 'FN');
  assert.equal(shortcutLabel({ keyCode: 0, modifiers: 0, keyLabel: 'old', modifierKeys: [58, 55] }), '左 Command + 左 Option');
  settings.shortcuts.dictation.push({ keyCode: 0, modifiers: 0, keyLabel: 'FN + 左 Shift', modifierKeys: [63, 56] });
  assert.throws(() => validateSettings(settings), /已被使用/);
  settings.shortcuts.dictation.pop();
  settings.shortcuts.selectionTranslation = [{ keyCode: 0, modifiers: FN_MODIFIER, keyLabel: 'A' }];
  validateSettings(settings);
});
test('旧设置迁移保留纯修饰键、语言和隐私，默认 ModelScope', () => {
  const settings = migrateSettings({ context: false, history: false, voiceTarget: 'ja', selectionTarget: 'zh-Hans', shortcuts: [{ keyCode: 0, modifiers: 0, keyLabel: '左 Control', modifierKeys: [59] }] });
  assert.equal(settings.modelSource, 'modelscope'); assert.equal(settings.keepHistory, false);
  assert.equal(settings.voiceTarget, 'ja'); assert.equal(settings.selectionTarget, 'zh-Hans');
  assert.equal(shortcutID(settings.shortcuts.dictation[0]), 'mod:59');
  settings.shortcuts.selectionTranslation.push(settings.shortcuts.dictation[0]);
  assert.throws(() => validateSettings(settings), /已被使用/);
});
test('首次使用引导只在全新安装时出现，完成后不再出现', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yanmo-guide-'));
  try {
    const fresh = new LibraryStore(join(directory, 'fresh'), defaultSettings());
    assert.equal(fresh.settings.onboarded, false);
    fresh.settings.onboarded = true; fresh.persist();
    assert.equal(new LibraryStore(join(directory, 'fresh'), defaultSettings()).settings.onboarded, true);
    // Settings saved before the guide existed lack the field: an existing user.
    const upgraded = join(directory, 'upgraded'); mkdirSync(upgraded);
    const { onboarded: _onboarded, ...older } = defaultSettings();
    older.online.text = { enabled: true, baseURL: 'https://api.example.test/v1', model: 'existing' };
    writeFileSync(join(upgraded, 'settings.json'), JSON.stringify({ ...older, llmModel: 'old-local-model' }));
    const migrated = new LibraryStore(upgraded, defaultSettings());
    assert.equal(migrated.settings.onboarded, true);
    assert.deepEqual(migrated.settings.online.text, older.online.text);
    assert.ok(!('llmModel' in migrated.settings));
    const legacy = join(directory, 'library.json'); writeFileSync(legacy, JSON.stringify({ manuscripts: [], lexicon: [] }));
    assert.equal(new LibraryStore(join(directory, 'migrated'), defaultSettings(), legacy).settings.onboarded, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('文稿迁移备份原数据并保留 Swift 日期，损坏文件不覆盖', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yanmo-store-'));
  try {
    const source = join(directory, 'original.json');
    const library = { manuscripts: [{ id: 'synthetic', date: 800000000, text: '合成样本', original: '合成样本', seconds: 2, application: '测试应用', polished: false }], lexicon: [] };
    writeFileSync(source, JSON.stringify(library));
    const target = join(directory, 'electron'); const store = new LibraryStore(target, defaultSettings(), source);
    assert.equal(store.library.manuscripts[0].date, 800000000);
    assert.equal(readFileSync(source, 'utf8'), readFileSync(join(target, 'library-v0.3-backup.json'), 'utf8'));
    store.close();
    const badTarget = join(directory, 'broken'); mkdirSync(badTarget);
    writeFileSync(join(badTarget, 'library.json'), 'broken');
    const broken = new LibraryStore(badTarget, defaultSettings());
    assert.ok(broken.error); assert.throws(() => broken.persist());
    assert.equal(readFileSync(join(badTarget, 'library.json'), 'utf8'), 'broken');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('SSE 分片和 CRLF 不丢失或提前提交结果', () => {
  const first = decodeSSE('data: {"event":"transcript","task_id":"1","text":"原文"}\r\n\r\ndata: {"event":"res');
  assert.equal(first.events.length, 1); assert.equal(first.events[0].text, '原文');
  const next = decodeSSE(first.rest + 'ult","task_id":"1","text":"完整结果"}\n\n');
  assert.equal(next.events.length, 1); assert.equal(next.events[0].text, '完整结果'); assert.equal(next.rest, '');
});
test('Markdown 保留表格和原始代码，HTML 与图片保持惰性', () => {
  const code = 'const text = "<script>alert(1)</script>";\n';
  const value = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\n' + code + '```\n\n<img src="https://invalid.example/a" onerror="alert(1)">\n\n![alt](https://invalid.example/a)');
  assert.ok(value.html.includes('<table>')); assert.deepEqual(value.codes, [code]);
  assert.ok(!value.html.includes('<img')); assert.ok(!value.html.includes('<script>'));
  assert.ok(value.html.includes('data-copy-code="0"'));
});
test('统一 SQLite 数据库保存发生时间、Opus 音频、多路转写与润色文本并支持清理', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yanmo-sqlite-'));
  try {
    const store = new LibraryStore(directory, defaultSettings());
    const now = cocoaNow();
    const expired = now - 5 * 86400;
    const opus = Buffer.from('OggS\x00\x02synthetic-opus');
    store.settings.retention = 1;
    store.settings.onboarded = true;
    store.library.lexicon.push({ id: 't1', term: '言墨', hint: '语音输入法', aliases: ['研墨'] });
    store.library.manuscripts.push(
      {
        id: 'recent', date: now, original: '原始转写', text: '润色正文', seconds: 3.2,
        application: '微信', polished: true,
        asrResults: [
          { engine_name: 'Qwen3-ASR', transcript: '原始转写', language: 'Chinese', language_source: 'detected' },
          { engine_name: 'SenseVoice Small', transcript: '第二路转写', language: 'Chinese', language_source: 'forced' },
        ],
      },
      { id: 'old', date: expired, original: '过期原文', text: '过期正文', seconds: 1, application: '备忘录', polished: true },
    );
    store.persist();
    store.persist({ id: 'recent', data: opus });
    store.persist({ id: 'old', data: opus });
    store.close();

    const db = new DatabaseSync(join(directory, 'yanmo.db'));
    const row = db.prepare('SELECT date, occurred_at, audio_opus, asr_results, text FROM manuscripts WHERE id = ?').get('recent') as {
      date: number; occurred_at: string; audio_opus: Uint8Array; asr_results: string; text: string;
    };
    assert.equal(row.date, now);
    assert.ok(row.occurred_at.endsWith('Z'));
    assert.deepEqual(Buffer.from(row.audio_opus), opus);
    assert.equal(JSON.parse(row.asr_results).length, 2);
    assert.equal(row.text, '润色正文');
    db.close();

    // SQLite alone restores state, lexicon, and the derived hasAudio flag.
    const reopened = new LibraryStore(directory, defaultSettings());
    assert.equal(reopened.settings.onboarded, true);
    assert.equal(reopened.library.lexicon[0].aliases?.[0], '研墨');
    assert.equal(reopened.library.manuscripts.find(item => item.id === 'recent')?.hasAudio, true);
    assert.deepEqual(reopened.getAudio('recent'), opus);

    reopened.prune();
    reopened.persist();
    assert.equal(reopened.library.manuscripts.length, 1);
    assert.equal(reopened.getAudio('old'), undefined);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
