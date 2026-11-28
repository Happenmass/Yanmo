import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface AcpmMockOptions {
  installedAsr?: string[];
  installedText?: string[];
  vadInstalled?: boolean;
  transcript?: string;
  language?: string;
  vadSegments?: { start_ms: number; end_ms: number }[];
  chatReply?: (promptCacheKey: string | undefined, userContent: string) => string;
}

export interface AcpmMockHandle {
  dataDir: string;
  baseURL: string;
  token: string;
  requests: { method: string; url: string; body: string }[];
  update(patch: Partial<AcpmMockOptions>): void;
  close(): Promise<void>;
}

export async function startAcpmMock(initial: AcpmMockOptions = {}): Promise<AcpmMockHandle> {
  const options: AcpmMockOptions = {
    installedAsr: ['qwen3-asr-1.7b', 'qwen3-asr-0.6b'],
    installedText: ['yanmo-correct-4b-cot'],
    vadInstalled: true,
    transcript: '预算三千五百元，周五交付，不是周四。',
    language: 'zh',
    vadSegments: [{ start_ms: 0, end_ms: 1500 }],
    ...initial,
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'yanmo-acpm-mock-'));
  const token = 'acpm-mock-token';
  const requests: { method: string; url: string; body: string }[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method || 'GET', url: req.url || '/', body });
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '1.0.0', platform: 'darwin-arm64' }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized', request_id: 'mock', stage: 'AUTH', detail: '401', elapsed_ms: 1, retryable: false } }));
        return;
      }
      if (req.url === '/v1/models') {
        const asrIds = ['qwen3-asr-1.7b', 'qwen3-asr-0.6b'];
        const models = [
          ...asrIds.map(id => ({
            id,
            capability: 'asr',
            display_name: id === 'qwen3-asr-1.7b' ? 'Qwen3-ASR 1.7B' : 'Qwen3-ASR 0.6B',
            installed: options.installedAsr!.includes(id),
            state: options.installedAsr!.includes(id) ? 'WARM' : 'STOPPED',
            pin_policy: 'auto',
            idle_timeout_sec: 1200,
          })),
          {
            id: 'yanmo-correct-4b-cot',
            capability: 'llm',
            display_name: 'Yanmo Correct 4B CoT',
            installed: options.installedText!.includes('yanmo-correct-4b-cot'),
            state: options.installedText!.includes('yanmo-correct-4b-cot') ? 'WARM' : 'STOPPED',
            pin_policy: 'auto',
            idle_timeout_sec: 1200,
          },
          {
            id: 'speech-vad-pyannote',
            capability: 'vad',
            display_name: 'Pyannote VAD',
            installed: options.vadInstalled !== false,
            state: 'WARM',
            pin_policy: 'pinned',
            idle_timeout_sec: 0,
          },
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models }));
        return;
      }
      if (req.url === '/v1/models/prewarm') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      if (req.url === '/v1/audio/vad') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ segments: options.vadSegments ?? [{ start_ms: 0, end_ms: 1500 }], duration_ms: 1600 }));
        return;
      }
      if (req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          text: options.transcript ?? '预算三千五百元，周五交付，不是周四。',
          language: options.language ?? 'zh',
          duration_ms: 1600,
          segments: [],
        }));
        return;
      }
      if (req.url === '/v1/audio/transcriptions/stream/start') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session_id: 'mock-stream-1', model: 'qwen3-asr-1.7b', sample_rate: 16000 }));
        return;
      }
      if (req.url === '/v1/audio/transcriptions/stream/chunk') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          session_id: 'mock-stream-1',
          confirmed_text: options.transcript ?? '预算三千五百元',
          provisional_text: '',
          language: options.language ?? 'zh',
          decode_ms: 12,
        }));
        return;
      }
      if (req.url === '/v1/audio/transcriptions/stream/reset') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session_id: 'mock-stream-1', status: 'ok' }));
        return;
      }
      if (req.url === '/v1/audio/transcriptions/stream/finish') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          session_id: 'mock-stream-1',
          text: options.transcript ?? '预算三千五百元，周五交付，不是周四。',
          language: options.language ?? 'zh',
          decode_ms: 15,
        }));
        return;
      }
      if (req.url === '/v1/audio/transcriptions/stream/close') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session_id: 'mock-stream-1', status: 'closed' }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body) as { prompt_cache_key?: string; messages?: { role: string; content: string }[] };
        const userContent = parsed.messages?.at(-1)?.content ?? '';
        const content = options.chatReply
          ? options.chatReply(parsed.prompt_cache_key, userContent)
          : parsed.prompt_cache_key?.startsWith('yanmo-translate')
            ? 'The budget is 3500 yuan. Deliver on Friday.'
            : parsed.prompt_cache_key === 'yanmo-correction-terms'
              ? '[]'
              : '预算3500元，周五交付，不是周四';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: 'yanmo-correct-4b-cot',
          choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        }));
        return;
      }
      res.writeHead(404).end();
    });
  }).listen(0, '127.0.0.1');

  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const baseURL = `http://127.0.0.1:${port}`;
  await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({
    version: 1,
    pid: process.pid,
    started_at: '2026-11-23T17:00:00Z',
    http_base_url: baseURL,
    native_ipc_path: join(dataDir, 'acpmd.sock'),
    token,
    platform: 'darwin-arm64',
    capabilities: ['llm', 'asr', 'tts', 'vad'],
    mdns_hostname: 'acpm.local',
    mdns_base_url: 'http://acpm.local:18790',
  }));

  return {
    dataDir,
    baseURL,
    token,
    requests,
    update(patch) { Object.assign(options, patch); },
    async close() {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
