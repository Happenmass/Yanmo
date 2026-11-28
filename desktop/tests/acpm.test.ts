import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AcpmClient,
  AcpmDiscoveryError,
  AcpmError,
  defaultAcpmDataDir,
  discoverAcpmRuntime,
  friendlyAcpmError,
  isPidAlive,
  normalizeAsrLanguage,
} from '../acpm';

function writeDiscovery(dir: string, overrides: Record<string, unknown> = {}) {
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({
    version: 1,
    pid: process.pid,
    started_at: '2026-11-23T17:00:00Z',
    http_base_url: 'http://127.0.0.1:18790',
    native_ipc_path: join(dir, 'acpmd.sock'),
    token: 'tok-initial',
    platform: 'darwin-arm64',
    capabilities: ['llm', 'asr', 'tts', 'vad'],
    mdns_hostname: 'acpm.local',
    mdns_base_url: 'http://acpm.local:18790',
    ...overrides,
  }));
}

test('discoverAcpmRuntime 校验文件存在、字段完整性与进程存活', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yanmo-acpm-disc-'));
  const previousEnv = process.env.YANMO_ACPM_DATA_DIR;
  try {
    process.env.YANMO_ACPM_DATA_DIR = dir;
    assert.equal(defaultAcpmDataDir(), dir);
    assert.throws(() => discoverAcpmRuntime(), (err: unknown) => err instanceof AcpmDiscoveryError && err.kind === 'missing');

    writeFileSync(join(dir, 'runtime.json'), '{not-json');
    assert.throws(() => discoverAcpmRuntime(dir), (err: unknown) => err instanceof AcpmDiscoveryError && err.kind === 'invalid');

    writeDiscovery(dir, { token: '' });
    assert.throws(() => discoverAcpmRuntime(dir), (err: unknown) => err instanceof AcpmDiscoveryError && err.kind === 'invalid');

    writeDiscovery(dir, { pid: 999999 });
    assert.equal(isPidAlive(999999), false);
    assert.throws(() => discoverAcpmRuntime(dir, true), (err: unknown) => err instanceof AcpmDiscoveryError && err.kind === 'stale');
    assert.equal(discoverAcpmRuntime(dir, false).pid, 999999);

    writeDiscovery(dir, { http_base_url: 'http://127.0.0.1:18790/' });
    const info = discoverAcpmRuntime(dir);
    assert.equal(info.http_base_url, 'http://127.0.0.1:18790');
    assert.equal(info.token, 'tok-initial');
  } finally {
    if (previousEnv === undefined) delete process.env.YANMO_ACPM_DATA_DIR;
    else process.env.YANMO_ACPM_DATA_DIR = previousEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AcpmClient 携带标准请求头、支持 JSON/Multipart、401 刷新重连与可重试错误退避', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yanmo-acpm-http-'));
  let activeToken = 'tok-1';
  let transientFailures = 1;
  const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });

      if (req.url === '/healthz') {
        assert.equal(req.headers.authorization, undefined);
        assert.equal(req.headers.origin, undefined);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '1.0', platform: 'darwin-arm64' }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${activeToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token', request_id: 'r1', stage: 'AUTH', detail: '401', elapsed_ms: 1, retryable: false } }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ id: 'qwen3-asr-1.7b', capability: 'asr', display_name: 'Qwen3-ASR 1.7B', installed: true, state: 'WARM', pin_policy: 'auto', idle_timeout_sec: 1200 }] }));
        return;
      }
      if (req.url === '/v1/models/prewarm') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      if (req.url === '/v1/audio/vad') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ segments: [{ start_ms: 100, end_ms: 900 }], duration_ms: 1000 }));
        return;
      }
      if (req.url === '/v1/audio/transcriptions') {
        if (transientFailures-- > 0) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'WORKER_CRASHED', message: 'worker exited', request_id: 'r2', stage: 'INFERENCE', detail: 'SIGKILL', elapsed_ms: 5, retryable: true } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '测试识别结果', language: 'zh', duration_ms: 900, segments: [] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body);
        if (parsed.model === 'missing-model') {
          res.writeHead(424, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'MODEL_NOT_INSTALLED', message: 'not installed', request_id: 'r3', stage: 'MODEL_PREPARE', detail: 'MISSING_WEIGHT_FILES', elapsed_ms: 2, retryable: false } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '纠错完成', reasoning_content: 'think' }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(404).end();
    });
  }).listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const baseURL = `http://127.0.0.1:${port}`;
    writeDiscovery(dir, { http_base_url: baseURL, token: 'tok-1' });

    const client = new AcpmClient({ mode: 'local', caller: 'yanmo-ime', dataDir: dir });
    assert.equal((await client.health()).status, 'ok');
    assert.equal((await client.models())[0].installed, true);
    await client.prewarm(['qwen3-asr-1.7b'], ['yanmo-polish']);

    // Simulate daemon restart rotating token in runtime.json -> client refreshes on 401 and succeeds.
    activeToken = 'tok-2';
    writeDiscovery(dir, { http_base_url: baseURL, token: 'tok-2' });
    const vad = await client.vad('/tmp/sample.wav');
    assert.equal(vad.segments.length, 1);

    // Buffer audio uses multipart; first attempt returns 502 retryable and second succeeds.
    const asr = await client.transcribe(Buffer.from('RIFF_WAV_BYTES'), { model: 'qwen3-asr-1.7b', prompt: 'Hotwords: 言墨' });
    assert.equal(asr.text, '测试识别结果');
    const asrReq = seen.at(-1)!;
    assert.match(String(asrReq.headers['content-type']), /^multipart\/form-data/);
    assert.equal(asrReq.headers['x-ai-priority'], 'interactive');
    assert.equal(asrReq.headers['x-ai-caller'], 'yanmo-ime');
    assert.ok(asrReq.headers['x-ai-request-id']);
    assert.equal(asrReq.headers.origin, undefined);

    const chat = await client.chatCompletions({
      model: 'yanmo-correct-4b-cot',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }],
      promptCacheKey: 'yanmo-polish',
    });
    assert.equal(chat.choices[0].message.content, '纠错完成');
    const chatBody = JSON.parse(seen.at(-1)!.body);
    assert.equal(chatBody.stream, false);
    assert.equal(chatBody.separate_reasoning, true);
    assert.equal(chatBody.prompt_cache_key, 'yanmo-polish');

    await assert.rejects(
      client.chatCompletions({ model: 'missing-model', messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => err instanceof AcpmError && err.code === 'MODEL_NOT_INSTALLED' && /尚未安装/.test(friendlyAcpmError(err)),
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeAsrLanguage 统一标准化语种标签', () => {
  assert.equal(normalizeAsrLanguage('zh'), 'Chinese');
  assert.equal(normalizeAsrLanguage('zh-Hans'), 'Chinese');
  assert.equal(normalizeAsrLanguage('Chinese'), 'Chinese');
  assert.equal(normalizeAsrLanguage('EN'), 'English');
  assert.equal(normalizeAsrLanguage('ja'), 'Japanese');
  assert.equal(normalizeAsrLanguage('de'), 'German');
  assert.equal(normalizeAsrLanguage('auto'), null);
  assert.equal(normalizeAsrLanguage('unknown'), null);
  assert.equal(normalizeAsrLanguage(''), null);
  assert.equal(normalizeAsrLanguage(null), null);
});

test('AcpmClient 支持流式 ASR 预览 start/chunk/reset/finish/close 协议及 prompt/priority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yanmo-acpm-stream-'));
  const seen: { url: string; priority: string | string[] | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      seen.push({ url: req.url!, priority: req.headers['x-ai-priority'], body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/v1/audio/transcriptions/stream/start') {
        res.end(JSON.stringify({ session_id: 'sess-1', model: 'qwen3-asr-1.7b', sample_rate: 16000 }));
      } else if (req.url === '/v1/audio/transcriptions/stream/chunk') {
        res.end(JSON.stringify({ session_id: 'sess-1', confirmed_text: '明天', provisional_text: '开会', language: 'Chinese', decode_ms: 14.2 }));
      } else if (req.url === '/v1/audio/transcriptions/stream/reset') {
        res.end(JSON.stringify({ session_id: 'sess-1', status: 'ok' }));
      } else if (req.url === '/v1/audio/transcriptions/stream/finish') {
        res.end(JSON.stringify({ session_id: 'sess-1', text: '明天开会。', language: 'Chinese', decode_ms: 8.5 }));
      } else {
        res.end(JSON.stringify({ session_id: 'sess-1', status: 'closed' }));
      }
    });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const client = new AcpmClient({ mode: 'remote', remoteBaseURL: `http://127.0.0.1:${port}`, remoteToken: 'tok' });

    const started = await client.startAsrStream({ model: 'qwen3-asr-1.7b', language: 'auto', prompt: 'Hotwords: 言墨' });
    assert.equal(started.session_id, 'sess-1');
    assert.equal(started.sample_rate, 16000);

    const chunk = await client.feedAsrStreamChunk({ model: 'qwen3-asr-1.7b', sessionId: 'sess-1', pcm16Base64: 'AAA=' });
    assert.equal(chunk.confirmed_text, '明天');
    assert.equal(chunk.provisional_text, '开会');

    const reset = await client.resetAsrStream({ model: 'qwen3-asr-1.7b', sessionId: 'sess-1', language: 'auto', prompt: 'Context: 前文\nHotwords: 言墨' });
    assert.equal(reset.status, 'ok');

    const finished = await client.finishAsrStream({ model: 'qwen3-asr-1.7b', sessionId: 'sess-1', pcm16Base64: 'BBB=', closeAfter: true });
    assert.equal(finished.text, '明天开会。');
    assert.equal(finished.language, 'Chinese');

    const closed = await client.closeAsrStream({ model: 'qwen3-asr-1.7b', sessionId: 'sess-1' });
    assert.equal(closed.status, 'closed');

    assert.equal(seen.length, 5);
    assert.equal(seen[0].priority, 'interactive');
    assert.equal(seen[1].priority, 'interactive');
    assert.equal(seen[2].priority, 'interactive');
    assert.equal(seen[3].priority, 'interactive');
    assert.equal(seen[4].priority, 'normal');
    assert.equal(seen[0].body.language, 'auto');
    assert.equal(seen[0].body.prompt, 'Hotwords: 言墨');
    assert.equal(seen[1].body.pcm16_base64, 'AAA=');
    assert.equal(seen[2].body.prompt, 'Context: 前文\nHotwords: 言墨');
    assert.equal(seen[3].body.pcm16_base64, 'BBB=');
    assert.equal(seen[3].body.close_after, true);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
