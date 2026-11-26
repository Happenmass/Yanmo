import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InferenceService, InferenceTaskPayload } from '../inference';
import { LibraryStore } from '../store';
import { defaultSettings, TaskEvent } from '../shared';

const promptsDir = resolve(__dirname, '../../engine');

function baseRequest(overrides: Partial<InferenceTaskPayload> = {}): InferenceTaskPayload {
  return {
    task_id: 'task-1',
    operation: 'dictation',
    text: '',
    target_language: 'en',
    asr_results: [],
    polish: true,
    style: '自然整理',
    archive_audio: false,
    acpm: defaultSettings().acpm,
    acpmToken: '',
    acpmTextReady: true,
    acpmVadReady: true,
    online: {},
    context: { application: '备忘录', category: 'document', lexicon: [], before: '', after: '' },
    ...overrides,
  };
}

test('InferenceService 调度 AcpmRuntime VAD / ASR / LLM、记录用量与归档警告，且诊断不含敏感正文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yanmo-infer-'));
  const acpmDir = join(dir, 'acpm');
  const diagDir = join(dir, 'diag');
  const dbDir = join(dir, 'db');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(acpmDir);
  mkdirSync(dbDir);
  const store = new LibraryStore(dbDir, defaultSettings());

  let vadSegments = [{ start_ms: 0, end_ms: 1200 }];
  let vadStatus = 200;
  let chatFinish = 'stop';
  let chatContent = '今天下午三点开会';
  const calls: { url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];

  const acpmServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ url: req.url!, headers: req.headers, body });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [
            { id: 'qwen3-asr-1.7b', capability: 'asr', display_name: 'ASR 1.7B', installed: true, state: 'WARM' },
            { id: 'yanmo-correct-4b-cot', capability: 'llm', display_name: 'Yanmo 4B', installed: false, state: 'STOPPED' },
            { id: 'speech-vad-pyannote', capability: 'vad', display_name: 'VAD', installed: true, state: 'WARM' },
          ],
        }));
        return;
      }
      if (req.url === '/v1/models/prewarm') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      if (req.url === '/v1/audio/vad') {
        res.writeHead(vadStatus, { 'Content-Type': 'application/json' });
        res.end(vadStatus === 200
          ? JSON.stringify({ segments: vadSegments, duration_ms: 1500 })
          : JSON.stringify({ error: { code: 'INFERENCE_FAILED', message: 'vad err', request_id: 'v1', stage: 'VAD', detail: 'ERR', elapsed_ms: 1, retryable: false } }));
        return;
      }
      if (req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'SECRET_TRANSCRIPT 今天下午三点开回', language: 'zh', duration_ms: 1500, segments: [] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body);
        const content = parsed.prompt_cache_key === 'yanmo-correction-terms'
          ? '["沈砚"]'
          : parsed.prompt_cache_key === 'yanmo-translate-selection'
            ? parsed.messages[1].content.includes('⟦YANMO_CODE_0⟧')
              ? 'Keep ⟦YANMO_CODE_0⟧ here.'
              : 'Translated text'
            : chatContent;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: 'hidden' }, finish_reason: chatFinish }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }));
        return;
      }
      res.writeHead(404).end();
    });
  }).listen(0, '127.0.0.1');

  const onlineServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ url: req.url!, headers: req.headers, body });
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body);
        assert.equal(parsed.model, 'deepseek-chat');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ index: 0, message: { content: '在线纠错结果' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 10 },
        }));
        return;
      }
      res.writeHead(404).end();
    });
  }).listen(0, '127.0.0.1');

  try {
    await Promise.all([once(acpmServer, 'listening'), once(onlineServer, 'listening')]);
    const acpmPort = (acpmServer.address() as { port: number }).port;
    const onlinePort = (onlineServer.address() as { port: number }).port;
    writeFileSync(join(acpmDir, 'runtime.json'), JSON.stringify({
      version: 1,
      pid: process.pid,
      started_at: '2026-11-23T17:00:00Z',
      http_base_url: `http://127.0.0.1:${acpmPort}`,
      native_ipc_path: join(acpmDir, 'acpmd.sock'),
      token: 'SECRET_ACPM_TOKEN',
      platform: 'darwin-arm64',
      capabilities: ['llm', 'asr', 'tts', 'vad'],
    }));

    let archiveShouldFail = false;
    const service = new InferenceService({
      promptsDir,
      diagnosticsDir: diagDir,
      usage: store,
      acpmDataDir: acpmDir,
      archiveAudio: async () => {
        if (archiveShouldFail) throw new Error('disk full');
        return Buffer.from('fLaC_SYNTHETIC');
      },
    });

    // 1. checkStatus reflects installed states
    const status = await service.checkStatus(defaultSettings(), { online: {}, acpmToken: '' });
    assert.equal(status.connected, true);
    assert.equal(status.asrReady, true);
    assert.equal(status.textReady, false);
    assert.equal(status.vadReady, true);

    // 2. Full dictation with AcpmRuntime ASR + LLM + FLAC archive
    const events: TaskEvent[] = [];
    await service.run(
      baseRequest({ archive_audio: true }),
      Buffer.from('RIFF_WAV_AUDIO'),
      event => events.push(event),
    );
    assert.deepEqual(events.map(e => e.event), ['stage', 'transcript', 'audio', 'stage', 'result']);
    assert.equal(events[1].asr_results?.[0].language, 'Chinese');
    assert.equal(events[2].audio_opus, Buffer.from('fLaC_SYNTHETIC').toString('base64'));
    assert.equal(events[4].text, '今天下午三点开会');
    assert.equal(events[4].processed, true);

    // 3. VAD empty segments skips ASR
    vadSegments = [];
    const noSpeech: TaskEvent[] = [];
    await service.run(baseRequest({ task_id: 'task-vad-empty' }), Buffer.from('RIFF_WAV'), e => noSpeech.push(e));
    assert.equal(noSpeech.at(-1)?.event, 'error');
    assert.match(noSpeech.at(-1)!.message!, /没有识别到语音/);

    // 4. VAD HTTP error gracefully falls back to ASR; archive failure emits warning but delivers result
    vadStatus = 500;
    archiveShouldFail = true;
    const fallbackEvents: TaskEvent[] = [];
    await service.run(baseRequest({ task_id: 'task-vad-fallback', archive_audio: true }), Buffer.from('RIFF_WAV'), e => fallbackEvents.push(e));
    assert.equal(fallbackEvents.find(e => e.event === 'audio')?.audio_warning, '录音未保存：音频压缩失败，文字处理继续。');
    assert.equal(fallbackEvents.at(-1)?.event, 'result');
    vadStatus = 200;
    vadSegments = [{ start_ms: 0, end_ms: 1200 }];
    archiveShouldFail = false;

    // 5. Verbatim style sets processed=false
    const verbatimEvents: TaskEvent[] = [];
    await service.run(baseRequest({ task_id: 'task-verbatim', style: '保留原话' }), Buffer.from('RIFF_WAV'), e => verbatimEvents.push(e));
    assert.equal(verbatimEvents.at(-1)?.processed, false);

    // 6. Selection translation protects Markdown code & short-circuits code-only
    const codeOnly: TaskEvent[] = [];
    await service.run(baseRequest({ task_id: 'task-code-only', operation: 'selectionTranslation', text: '```js\n1\n```' }), undefined, e => codeOnly.push(e));
    assert.equal(codeOnly.at(-1)?.text, '```js\n1\n```');

    const mdTranslate: TaskEvent[] = [];
    await service.run(baseRequest({ task_id: 'task-md', operation: 'selectionTranslation', text: '保留 `foo()` 在这里。' }), undefined, e => mdTranslate.push(e));
    assert.equal(mdTranslate.at(-1)?.text, 'Keep `foo()` here.');

    // 7. Online text override delivers output and tracks usage
    const deepseekEvents: TaskEvent[] = [];
    await service.run(baseRequest({
      task_id: 'task-ds',
      operation: 'polish',
      text: '原文',
      acpmTextReady: false,
      online: { text: { base_url: `http://127.0.0.1:${onlinePort}/v1`, model: 'deepseek-chat', api_key: 'SECRET_API_KEY' } },
    }), undefined, e => deepseekEvents.push(e));
    assert.equal(deepseekEvents.at(-1)?.text, '在线纠错结果');

    // 8. Truncated finish_reason='length' rejects output
    chatFinish = 'length';
    const truncated: TaskEvent[] = [];
    await service.run(baseRequest({ task_id: 'task-trunc', operation: 'polish', text: '原文' }), undefined, e => truncated.push(e));
    assert.equal(truncated.at(-1)?.event, 'error');
    assert.match(truncated.at(-1)!.message!, /长度上限/);
    chatFinish = 'stop';

    // 9. Correction terms extraction
    const terms = await service.extractCorrectionTerms('联系沈言', '联系沈砚', defaultSettings(), { online: {}, acpmToken: '' });
    assert.deepEqual(terms, ['沈砚']);

    // 10. Abort/cancel emits cancelled
    const abort = new AbortController();
    abort.abort();
    const cancelled: TaskEvent[] = [];
    await service.run(baseRequest({ task_id: 'task-cancel' }), Buffer.from('RIFF_WAV'), e => cancelled.push(e), abort.signal);
    assert.equal(cancelled.at(-1)?.event, 'cancelled');

    // Verify SQLite usage & content-free diagnostics
    const db = new DatabaseSync(store.dbPath, { readOnly: true });
    try {
      const usageCount = Number(db.prepare("SELECT count(*) AS n FROM llm_usage_events WHERE status='response'").get()!.n);
      assert.ok(usageCount >= 4);
    } finally { db.close(); }

    const diagLog = readFileSync(join(diagDir, 'inference.jsonl'), 'utf8');
    assert.ok(diagLog.includes('task_start'));
    assert.ok(!diagLog.includes('SECRET_TRANSCRIPT'));
    assert.ok(!diagLog.includes('SECRET_ACPM_TOKEN'));
    assert.ok(!diagLog.includes('SECRET_API_KEY'));
  } finally {
    store.close();
    acpmServer.close();
    onlineServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('InferenceService 对 api.deepseek.com 注入 thinking 与 reasoning_effort', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const service = new InferenceService({
    promptsDir,
    fetchImpl: (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { content: '完成' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });
  const events: TaskEvent[] = [];
  await service.run(baseRequest({
    operation: 'polish',
    text: '待整理',
    acpmTextReady: false,
    online: { text: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: 'sk' } },
  }), undefined, e => events.push(e));
  assert.equal(events.at(-1)?.text, '完成');
  assert.deepEqual(capturedBody?.thinking, { type: 'enabled' });
  assert.equal(capturedBody?.reasoning_effort, 'low');
});

test('InferenceService.transcribeSegment 拼接前置上下文、执行 Pyannote 空音频门控并避免重复 vad_filter', async () => {
  let vadSegments: { start_ms: number; end_ms: number }[] = [];
  const transcribeCalls: { prompt?: string; vad_filter?: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/audio/vad') {
      res.end(JSON.stringify({ segments: vadSegments, duration_ms: 800 }));
      return;
    }
    if (req.url === '/v1/audio/transcriptions') {
      const promptMatch = bodyText.match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/);
      const vadMatch = bodyText.match(/name="vad_filter"\r\n\r\n([\s\S]*?)\r\n--/);
      transcribeCalls.push({ prompt: promptMatch?.[1], vad_filter: vadMatch?.[1] });
      res.end(JSON.stringify({ text: '下一句识别结果', language: 'Chinese' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    const service = new InferenceService({ promptsDir });
    const req = baseRequest({
      asr_hotwords: ['言墨'],
      acpm: { ...defaultSettings().acpm, mode: 'remote', remoteBaseURL: baseUrl, vadEnabled: true },
      acpmToken: 'test-token',
      acpmVadReady: true,
      context: { application: '备忘录', category: 'document', lexicon: [], before: '编辑器前缀', after: '' },
    });

    // 1. Empty Pyannote VAD result skips ASR cleanly without throwing
    vadSegments = [];
    const empty = await service.transcribeSegment(req, Buffer.from('RIFF_WAV'), '前一段已识别');
    assert.equal(empty.text, '');
    assert.equal(transcribeCalls.length, 0);

    // 2. Non-empty Pyannote VAD chains context and sends vad_filter=false
    vadSegments = [{ start_ms: 40, end_ms: 720 }];
    const hit = await service.transcribeSegment(req, Buffer.from('RIFF_WAV'), '前一段已识别');
    assert.equal(hit.text, '下一句识别结果');
    assert.equal(hit.language, 'Chinese');
    assert.equal(transcribeCalls.length, 1);
    assert.equal(transcribeCalls[0].vad_filter, 'false');
    assert.match(transcribeCalls[0].prompt!, /Hotwords: 言墨/);
    assert.match(transcribeCalls[0].prompt!, /编辑器前缀前一段已识别/);
  } finally {
    server.close();
  }
});
