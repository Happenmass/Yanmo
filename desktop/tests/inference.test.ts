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
          ? '["沈砚","原文已有词"]'
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

    // 9. Correction terms extraction: short-circuits non-substantive edits & filters terms already verbatim in original
    const skippedCallsBefore = calls.length;
    assert.deepEqual(
      await service.extractCorrectionTerms('明天联系沈砚。', '\u200B明天联系沈砚。\n补充一句', defaultSettings(), { online: {}, acpmToken: '' }),
      [],
    );
    assert.equal(calls.length, skippedCallsBefore);
    const terms = await service.extractCorrectionTerms('原文已有词 联系沈言', '原文已有词 联系沈砚', defaultSettings(), { online: {}, acpmToken: '' });
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

test('InferenceService 仅向 ASR 传入热词，所有文字后处理均清空词库', async () => {
  const asrPrompts: (string | null)[] = [];
  const chatPayloads: Record<string, unknown>[] = [];
  const service = new InferenceService({
    promptsDir,
    fetchImpl: (async (url, init) => {
      const urlString = String(url);
      if (urlString.endsWith('/audio/transcriptions')) {
        const form = init?.body as FormData;
        const prompt = form.get('prompt');
        asrPrompts.push(typeof prompt === 'string' ? prompt : null);
        return new Response(JSON.stringify({ text: '测试言墨识别' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlString.endsWith('/chat/completions')) {
        const parsed = JSON.parse(String(init?.body));
        chatPayloads.push(JSON.parse(String(parsed.messages[1].content)));
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { content: '测试输出' }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected URL: ${urlString}`);
    }) as typeof fetch,
  });

  const online = {
    asr: { base_url: 'https://api.example.com/v1', model: 'whisper-1', api_key: 'sk' },
    text: { base_url: 'https://api.example.com/v1', model: 'qwen-plus', api_key: 'sk' },
  };
  const contextWithLexicon = {
    application: '备忘录',
    category: 'document',
    lexicon: [{ term: '言墨', hint: '本地语音输入法', aliases: ['研墨'] }],
    before: '',
    after: '',
  };

  // 1. dictation (polish)
  await service.run(baseRequest({
    task_id: 't-dictation-polish',
    operation: 'dictation',
    style: '自然整理',
    asr_hotwords: ['言墨'],
    acpmTextReady: false,
    online,
    context: contextWithLexicon,
  }), Buffer.from('RIFF_WAV'), () => {});

  // 2. dictation (verbatim)
  await service.run(baseRequest({
    task_id: 't-dictation-verbatim',
    operation: 'dictation',
    style: '保留原话',
    pretranscribed: true,
    text: '原文',
    asr_hotwords: ['言墨'],
    acpmTextReady: false,
    online: { text: online.text },
    context: contextWithLexicon,
  }), undefined, () => {});

  // 3. manual polish
  await service.run(baseRequest({
    task_id: 't-polish',
    operation: 'polish',
    text: '原文',
    asr_hotwords: ['言墨'],
    acpmTextReady: false,
    online: { text: online.text },
    context: contextWithLexicon,
  }), undefined, () => {});

  // 4. voiceTranslation
  await service.run(baseRequest({
    task_id: 't-voice-trans',
    operation: 'voiceTranslation',
    pretranscribed: true,
    text: '你好',
    target_language: 'en',
    asr_hotwords: ['言墨'],
    acpmTextReady: false,
    online: { text: online.text },
    context: contextWithLexicon,
  }), undefined, () => {});

  // 5. selectionTranslation
  await service.run(baseRequest({
    task_id: 't-selection-trans',
    operation: 'selectionTranslation',
    text: '你好',
    target_language: 'en',
    acpmTextReady: false,
    online: { text: online.text },
    context: contextWithLexicon,
  }), undefined, () => {});

  assert.equal(asrPrompts.length, 1);
  assert.match(asrPrompts[0]!, /Hotwords: 言墨/);
  assert.equal(chatPayloads.length, 5);
  assert.equal(Object.hasOwn(chatPayloads[0].AUDIO_CONTEXT as object, 'lexicon'), false);
  assert.deepEqual((chatPayloads[1].CONTEXT as { lexicon: unknown[] }).lexicon, []);
  assert.equal(Object.hasOwn(chatPayloads[2].AUDIO_CONTEXT as object, 'lexicon'), false);
  assert.deepEqual((chatPayloads[3].CONTEXT as { lexicon: unknown[] }).lexicon, []);
  assert.deepEqual((chatPayloads[4].GLOSSARY), []);
});

test('InferenceService 流式 ASR 预览在旧版 404 或在线 ASR 下优雅降级并始终传 language=auto', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yanmo-stream-infer-'));
  let return404 = true;
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({ url: req.url!, body });
      if (return404) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found', request_id: 'r1', stage: 'HTTP_ADMISSION', detail: '404', elapsed_ms: 0, retryable: false } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/v1/audio/transcriptions/stream/start') {
        res.end(JSON.stringify({ session_id: 's-live', model: 'qwen3-asr-1.7b', sample_rate: 16000 }));
      } else if (req.url === '/v1/audio/transcriptions/stream/chunk') {
        res.end(JSON.stringify({ session_id: 's-live', confirmed_text: '早上', provisional_text: '好', language: 'Chinese', decode_ms: 9 }));
      } else if (req.url === '/v1/audio/transcriptions/stream/finish') {
        res.end(JSON.stringify({ session_id: 's-live', text: '早上好用言墨。', language: 'Chinese', decode_ms: 12 }));
      } else {
        res.end(JSON.stringify({ session_id: 's-live', status: 'ok' }));
      }
    });
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const service = new InferenceService({ promptsDir });
    const req = baseRequest({
      acpm: { mode: 'remote', remoteBaseURL: `http://127.0.0.1:${port}`, asrModel: 'qwen3-asr-1.7b', textModel: 'yanmo-correct-4b-cot', vadEnabled: true },
      acpmToken: 'tok',
      online: {},
      context: { application: 'Notes', category: 'document', lexicon: [], before: '会议纪要', after: '' },
      asr_hotwords: ['言墨', 'AcpmRuntime'],
    });

    // Online ASR skips local stream preview & finish
    const onlineReq = baseRequest({ ...req, online: { asr: { base_url: 'https://api.example.com/v1', model: 'whisper-1', api_key: 'k' } } });
    assert.equal(await service.startAsrStream(onlineReq), null);
    assert.equal(await service.finishAsrStream(onlineReq, 's-live'), null);

    // Older AcpmRuntime returning 404 degrades gracefully to null
    assert.equal(await service.startAsrStream(req), null);
    assert.equal(await service.finishAsrStream(req, 's-live'), null);

    // Newer AcpmRuntime succeeds and passes language: 'auto' + Hotwords/before prompt
    return404 = false;
    const started = await service.startAsrStream(req, '');
    assert.deepEqual(started, { sessionId: 's-live', model: 'qwen3-asr-1.7b' });
    const chunk = await service.feedAsrStreamChunk(req, 's-live', 'AAAA');
    assert.deepEqual(chunk, { confirmedText: '早上', provisionalText: '好' });
    await service.resetAsrStream(req, 's-live', '前一段识别正文');
    const finished = await service.finishAsrStream(req, 's-live', { pcm16Base64: 'BBBB', closeAfter: true });
    assert.deepEqual(finished, {
      text: '早上好用言墨。',
      engine: 'qwen3-asr-1.7b',
      language: 'Chinese',
      languageSource: 'detected',
    });
    await service.closeAsrStream(req, 's-live');
    const startReq = requests.filter(r => r.url === '/v1/audio/transcriptions/stream/start').at(-1);
    const resetReq = requests.filter(r => r.url === '/v1/audio/transcriptions/stream/reset').at(-1);
    assert.equal(startReq?.body.language, 'auto');
    assert.match(String(startReq?.body.prompt), /会议纪要/);
    assert.match(String(startReq?.body.prompt), /Hotwords: 言墨, AcpmRuntime/);
    assert.match(String(resetReq?.body.prompt), /前一段识别正文/);
    assert.match(String(resetReq?.body.prompt), /Hotwords: 言墨, AcpmRuntime/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
