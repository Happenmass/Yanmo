import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildAsrPrompt,
  buildFusionPayload,
  buildPolishPayload,
  buildTranslationPayload,
  buildVerbatimPrompt,
  buildVoiceTranslationPrompt,
  detectLanguageHint,
  hasCorrectionDiff,
  loadPromptTemplates,
  normalizeCorrectionText,
  normalizeLexicon,
  parseCorrectionTerms,
  protectMarkdownCode,
  restoreMarkdownCode,
} from '../prompts';

const promptsDir = resolve(__dirname, '../../engine');

test('loadPromptTemplates 原样加载 engine/polish.txt 与模板', () => {
  const templates = loadPromptTemplates(promptsDir);
  assert.equal(templates.polish, readFileSync(resolve(promptsDir, 'polish.txt'), 'utf8'));
  assert.ok(templates.system.includes('{{TASK_INSTRUCTION}}'));
  assert.ok(templates.correction.includes('ORIGINAL'));
});

test('normalizeLexicon 稳定键序、合并备注与别名并去重', () => {
  const items = normalizeLexicon({
    lexicon: [
      '言墨',
      { term: ' 言墨 ', hint: '输入法', aliases: ['研墨', '言墨', '研墨'] },
      { term: 'AcpmRuntime', hint: '', aliases: ['ACPM'] },
    ],
    key_terms: [{ term: 'AcpmRuntime', aliases: ['acpm-desktop'] }],
    term_notes: [{ term: 'AcpmRuntime', hint: '推理后端' }],
  });
  assert.deepEqual(items, [
    { term: '言墨', hint: '输入法', aliases: ['研墨'] },
    { term: 'AcpmRuntime', hint: '推理后端', aliases: ['ACPM', 'acpm-desktop'] },
  ]);
  assert.deepEqual(Object.keys(items[0]), ['term', 'hint', 'aliases']);
});

test('buildPolishPayload 与 buildAsrPrompt 保持字段布局与上下文截断', () => {
  const before = '甲'.repeat(350);
  const after = '乙'.repeat(350);
  const polish = buildPolishPayload({
    instruction: '整理为即时消息。',
    application: '微信',
    category: 'messaging',
    lexicon: [{ term: '言墨', hint: '', aliases: ['研墨'] }],
    before,
    after,
    asr_results: [{ engine_name: 'qwen3-asr-1.7b', transcript: '你好' }],
  });
  assert.deepEqual(Object.keys(polish), ['INSTRUCTION', 'AUDIO_CONTEXT', 'context', 'ASR_RESULTS']);
  assert.deepEqual(Object.keys(polish.AUDIO_CONTEXT), ['application', 'background_screen_text']);
  assert.equal(polish.context.text_before_cursor.length, 300);
  assert.equal(polish.context.text_after_cursor.length, 300);
  assert.deepEqual(polish.AUDIO_CONTEXT.application, { categories: ['messaging'], name: '微信' });

  const prompt = buildAsrPrompt({ before: '请打开<|endoftext|>' }, ['言墨', 'AcpmRuntime']);
  assert.equal(prompt, 'Hotwords: 言墨, AcpmRuntime\n请打开< |endoftext|>');
});

test('buildVerbatimPrompt 与 buildVoiceTranslationPrompt 保持静态系统前缀和动态载荷后置', () => {
  const templates = loadPromptTemplates(promptsDir);
  const verbatimA = buildVerbatimPrompt(templates, {
    text: '嗯，今天下午三点开会。',
    asr_results: [{ engine_name: 'qwen3-asr-1.7b', transcript: '嗯，今天下午三点开会。', language: 'Chinese' }],
  });
  const verbatimB = buildVerbatimPrompt(templates, {
    text: 'Please review the PR.',
    asr_results: [{ engine_name: 'qwen3-asr-1.7b', transcript: 'Please review the PR.', language: 'English' }],
  });
  // Static prefix invariant for KV cache reuse across verbatim requests.
  assert.equal(verbatimA.system, verbatimB.system);
  assert.equal(verbatimA.promptCacheKey, 'yanmo-verbatim');
  assert.match(String(verbatimA.payload.OUTPUT_LANGUAGE), /source hint: zh/);
  assert.match(String(verbatimB.payload.OUTPUT_LANGUAGE), /source hint: en/);

  const translation = buildVoiceTranslationPrompt(templates, {
    asr_results: [{ engine_name: 'qwen3-asr-1.7b', transcript: '明天见', language: 'Chinese' }],
  }, 'ja');
  assert.equal(translation.promptCacheKey, 'yanmo-translate-voice-ja');
  assert.match(translation.system, /Japanese/);
  assert.equal(buildFusionPayload({ text: 'x' }, 'translate', 'Japanese').payload.TARGET_LANGUAGE, 'Japanese');
});

test('protectMarkdownCode / restoreMarkdownCode 保护围栏、未闭合围栏与行内代码并拒绝丢失占位符', () => {
  const source = '# Title\n\nUse `const x = 1` here and keep ⟦YANMO_CODE_ literal.\n\n```ts\nconst y = 2;\n```\n\n```\nunclosed fence';
  const { masked, protectedMap } = protectMarkdownCode(source);
  assert.equal(protectedMap.size, 3);
  assert.ok(!masked.includes('const x = 1'));
  assert.ok(!masked.includes('const y = 2'));
  assert.ok(!masked.includes('unclosed fence'));
  assert.equal(restoreMarkdownCode(masked, protectedMap), source);

  const dropped = masked.replace([...protectedMap.keys()][1], '');
  assert.throws(() => restoreMarkdownCode(dropped, protectedMap), /未完整保留代码/);
});

test('buildTranslationPayload、detectLanguageHint 与 parseCorrectionTerms 边界校验', () => {
  assert.throws(() => buildTranslationPayload({ text: '', target_language: 'en' }), /没有可翻译/);
  assert.throws(() => buildTranslationPayload({ text: 'a'.repeat(4001), target_language: 'en' }), /4000/);
  const payload = buildTranslationPayload({ text: '你好', target_language: 'en', application: 'Safari' });
  assert.equal(payload.TARGET_LANGUAGE, 'English');

  assert.equal(detectLanguageHint('今天下午三点去北京开会。'), 'zh');
  assert.equal(detectLanguageHint('明日の午後三時に会議があります。'), 'ja');
  assert.equal(detectLanguageHint('Please review the draft before Friday.'), 'en');
  assert.equal(detectLanguageHint('`const x = 1` https://example.com'), null);

  assert.deepEqual(
    parseCorrectionTerms('["沈砚","PostgreSQL","沈砚","不在原文里","多\\n行"]', '明天联系沈砚，检查 PostgreSQL 的索引。'),
    ['沈砚', 'PostgreSQL'],
  );
  assert.deepEqual(
    parseCorrectionTerms(
      '["AcpmRuntime","沈砚","PostgreSQL"]',
      '用 AcpmRuntime 联系沈砚，检查 PostgreSQL。',
      '用 AcpmRuntime 联系沈言，检查 postgresql。',
    ),
    ['沈砚', 'PostgreSQL'],
  );
  assert.deepEqual(
    parseCorrectionTerms(
      '["沈砚"]',
      '沈砚说请明天联系沈砚。',
      '沈砚说请明天联系沈言。',
    ),
    ['沈砚'],
  );
  assert.throws(() => parseCorrectionTerms('not-json', 'x'), /格式无效/);
  assert.throws(() => parseCorrectionTerms(JSON.stringify(Array.from({ length: 11 }, (_, i) => `t${i}`)), 'x'), /格式无效/);

  assert.equal(normalizeCorrectionText('\u200B第一行\r\n第二行\u00A0 '), '第一行\n第二行');
  assert.equal(hasCorrectionDiff('明天联系沈砚。', '\u200B明天联系\uFEFF沈砚。\uFFFC'), false);
  assert.equal(hasCorrectionDiff('明天联系沈砚。', '明天联系沈砚'), false);
  assert.equal(hasCorrectionDiff('明天联系沈砚。', '@张三 明天联系沈砚。'), false);
  assert.equal(hasCorrectionDiff('明天联系沈砚。', '请问明天联系沈砚。'), false);
  assert.equal(hasCorrectionDiff('明天联系沈砚。', '明天联系沈砚。\n顺便发我'), false);
  assert.equal(hasCorrectionDiff('明天联系沈言。', '明天联系沈砚。'), true);
  assert.equal(hasCorrectionDiff('明天联系沈言确认方案。', '草稿：明天联系沈砚确认方案。'), true);
  assert.equal(hasCorrectionDiff('检查 Postgre', '检查 PostgreSQL'), true);
  assert.equal(hasCorrectionDiff('联系沈', '联系沈砚'), true);
  assert.equal(hasCorrectionDiff('看下 v1.', '看下 v1.2'), true);
});
