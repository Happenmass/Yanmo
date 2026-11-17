import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchedTermIDs, scopedTerms, selectASRHotwords } from '../hotwords';
import { Term, TermGroup } from '../shared';

function words(prefix: string, count: number, group?: TermGroup): Term[] {
  return Array.from({ length: count }, (_, index) => ({
    id: prefix + index, term: prefix + index, hint: '', group, matchCount: count - index,
  }));
}

test('热词分配 48+16，任一边不足可互补，未知应用只使用全局', () => {
  const app = words('ai', 72, 'ai_tools');
  const global = words('global', 72);
  const other = words('mail', 72, 'email');
  const select = (local: Term[], shared: Term[], category?: string) => selectASRHotwords(scopedTerms([...local, ...shared, ...other], category));
  const names = (entries: Term[]) => entries.map(entry => entry.term);
  assert.deepEqual(select(app, global, 'ai_tools'), names([...app.slice(0, 48), ...global.slice(0, 16)]));
  assert.deepEqual(select(app.slice(0, 2), global, 'ai_tools'), names([...app.slice(0, 2), ...global.slice(0, 62)]));
  assert.deepEqual(select(app, global.slice(0, 1), 'ai_tools'), names([...app.slice(0, 63), ...global.slice(0, 1)]));
  assert.deepEqual(select(app.slice(0, 2), global.slice(0, 3), 'ai_tools'), names([...app.slice(0, 2), ...global.slice(0, 3)]));
  for (const category of [undefined, 'general', 'unknown']) {
    assert.deepEqual(select(app, global, category), names(global.slice(0, 64)));
  }
});

test('同名组内词优先于高频全局词，组内按次数、最近命中、新建时间稳定排序', () => {
  const base = { hint: '', group: 'ai_tools' as const };
  const scope = scopedTerms([
    { ...base, id: 'old', term: '旧词', createdAt: 1 },
    { ...base, id: 'new', term: '新词', createdAt: 2 },
    { ...base, id: 'recent', term: '最近命中', matchCount: 3, lastMatchedAt: 9 },
    { ...base, id: 'older', term: '上次命中', matchCount: 3, lastMatchedAt: 8 },
    { ...base, id: 'frequent', term: '高频词', matchCount: 4, lastMatchedAt: 1 },
    { id: 'global', term: ' Claude   Code ', hint: '', matchCount: 1000 },
    { ...base, id: 'app', term: 'Ｃｌａｕｄｅ Code' },
  ], 'ai_tools');
  assert.deepEqual(scope.application.map(item => item.id), ['frequent', 'recent', 'older', 'new', 'old', 'app']);
  assert.deepEqual(scope.global, []);
});

test('命中按规范词去重，英文词边界与符号不误匹配，别名不计数', () => {
  const entries = [
    { id: 'ai', term: 'AI', hint: '' },
    { id: 'mcp', term: 'MCP', hint: '' },
    { id: 'cpp', term: 'C++', hint: '' },
    { id: 'name', term: '沈砚', hint: '', aliases: ['审验'] },
  ];
  assert.deepEqual([...matchedTermIDs(entries, 'openAI 和 AI_tools，ＭＣＰ、mcp、C++、审验')], ['mcp', 'cpp']);
});
