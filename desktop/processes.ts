import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Settings, TaskEvent } from './shared';

export class NativeBridge extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private pending = new Map<string, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private executable: string) { super(); }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], { env: { ...process.env, YANMO_PARENT_PID: String(process.pid) }, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      const timeout = setTimeout(() => { reject(new Error('系统桥接启动超时。')); child.kill(); }, 15000);
      createInterface({ input: child.stdout }).on('line', line => {
        let value: any; try { value = JSON.parse(line); } catch { return; }
        if (value.event === 'ready') { clearTimeout(timeout); if (value.protocol !== 1) reject(new Error('系统桥接版本不匹配。')); else resolve(); }
        else if (value.id) {
          const pending = this.pending.get(value.id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(value.id); if (value.ok) pending.resolve(value.result); else pending.reject(new Error(value.error || '系统操作失败。')); }
        } else if (value.event) this.emit(value.event, value);
      });
      child.stderr.resume();
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', () => {
        clearTimeout(timeout); this.starting = undefined; this.child = undefined;
        const error = new Error('系统桥接已退出。'); reject(error);
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear(); this.emit('fault', error);
      });
    });
    return this.starting;
  }
  async call<T = any>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('系统操作超时，请重新检查权限。')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, command, args }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  stop() { this.child?.stdin.end(); }
}

export function decodeSSE(buffer: string): { events: TaskEvent[]; rest: string } {
  const frames = buffer.split(/\r?\n\r?\n/); const rest = frames.pop()!;
  const events = frames.flatMap(frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data ? [JSON.parse(data) as TaskEvent] : [];
  });
  return { events, rest };
}

export class BackendClient {
  private child?: ReturnType<typeof spawn>;
  private starting?: Promise<void>;
  private origin = '';
  private token = '';
  private idle?: NodeJS.Timeout;
  private active = false;
  private requests = 0;
  constructor(private python: string, private root: string, private idleMs = 3600000, private diagnosticsDirectory?: string) {}
  private diagnostic(event: string, fields: Record<string, unknown> = {}) {
    if (!this.diagnosticsDirectory) return;
    try {
      mkdirSync(this.diagnosticsDirectory, { recursive: true, mode: 0o700 });
      const path = join(this.diagnosticsDirectory, "desktop.jsonl");
      try { if (statSync(path).size > 2_000_000) renameSync(path, path + ".1"); } catch {}
      appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + "\n", { mode: 0o600 });
    } catch { /* Diagnostics cannot interrupt input. */ }
  }
  private start() {
    if (this.starting) return this.starting;
    this.token = randomBytes(32).toString('hex');
    this.starting = new Promise<void>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, YANMO_BACKEND_TOKEN: this.token, YANMO_SUPERVISED: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUNBUFFERED: '1' };
      if (this.diagnosticsDirectory) env.YANMO_DIAGNOSTICS_DIR = this.diagnosticsDirectory;
      delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV;
      const child = spawn(this.python, ['-B', '-u', '-m', 'backend.server'], { cwd: this.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      const timeout = setTimeout(() => { reject(new Error('本地推理后端启动超时。')); child.kill(); }, 30000);
      createInterface({ input: child.stdout! }).on('line', line => {
        try { const value = JSON.parse(line); if (value.event === 'ready' && value.protocol === 1 && Number.isInteger(value.port) && value.port > 0 && value.port < 65536) { this.origin = 'http://127.0.0.1:' + value.port; clearTimeout(timeout); resolve(); } } catch { /* Libraries cannot write protocol messages. */ }
      });
      child.stderr!.resume();
      child.on('error', error => { clearTimeout(timeout); reject(new Error('无法启动内置 Python：' + error.message)); });
      child.on('close', (code, signal) => { this.diagnostic('backend_exit', { code, signal }); clearTimeout(timeout); if (this.child === child) { this.child = undefined; this.starting = undefined; this.origin = ''; } reject(new Error('本地推理后端已退出。')); });
    });
    return this.starting;
  }
  setActive(value: boolean) { this.active = value; this.scheduleIdle(); }
  /** Switches interpreter (Windows: bundled gateway ↔ PyTorch venv); the next request restarts the backend. */
  usePython(python: string) { if (python !== this.python) { this.python = python; void this.stop(); } }
  private scheduleIdle() {
    clearTimeout(this.idle);
    if (!this.active && !this.requests && this.child) this.idle = setTimeout(() => void this.stop(), this.idleMs);
  }
  private async request(path: string, init: RequestInit = {}) {
    clearTimeout(this.idle); this.requests++;
    try {
      await this.start();
      const response = await fetch(this.origin + path, { ...init, headers: { ...init.headers, Authorization: 'Bearer ' + this.token }, signal: init.signal ?? AbortSignal.timeout(180000) });
      if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.detail || '本地推理请求失败。'); }
      return response;
    } catch (error) { throw new Error(error instanceof Error ? error.message : '本地后端连接失败。'); }
    finally { this.requests--; this.scheduleIdle(); }
  }
  async status(settings: Settings) {
    const params = new URLSearchParams({ asr_model: settings.asrModel, llm_model: settings.llmModel, sensevoice_model: settings.senseVoiceModel, model_source: settings.modelSource });
    return (await this.request('/v1/status?' + params)).json();
  }
  async warmup(settings: Settings, includeLLM: boolean) {
    await this.request('/v1/warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asr_model: settings.asrModel, llm_model: settings.llmModel, sensevoice_model: settings.senseVoiceModel, model_source: settings.modelSource, include_llm: includeLLM }) });
  }
  async run(payload: Record<string, unknown>, audio: string | undefined, onEvent: (event: TaskEvent) => void) {
    const body = new FormData(); body.set('request', JSON.stringify(payload));
    if (audio) body.set('audio', new Blob([await readFile(audio)]), 'recording.wav');
    // Retain the lifecycle hold for the full stream, not just response headers.
    this.requests++;
    let terminal = false;
    let stage = "requesting";
    const started = Date.now();
    this.diagnostic("task_start", { task_id: payload.task_id, operation: payload.operation });
    try {
      const response = await this.request('/v1/tasks', { method: 'POST', body });
      if (!response.body) throw new Error('本地后端没有返回结果。');
      let buffer = ''; const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const parsed = decodeSSE(buffer); buffer = parsed.rest;
        for (const event of parsed.events) {
          if (event.task_id !== payload.task_id) throw new Error('本地后端任务编号不匹配。');
          if (['result', 'error', 'cancelled'].includes(event.event)) { if (terminal) throw new Error('本地后端重复返回结果。'); terminal = true; }
          if (event.event === "stage") stage = event.stage || stage;
          this.diagnostic("task_event", { task_id: payload.task_id, event_type: event.event, stage, elapsed_ms: Date.now() - started });
          onEvent(event);
        }
      }
      if (!terminal || buffer.trim()) throw new Error('本地推理结果未完整返回。');
    } catch (error) {
      this.diagnostic("task_transport_error", { task_id: payload.task_id, stage, terminal, error_type: error instanceof Error ? error.name : "Unknown", elapsed_ms: Date.now() - started });
      throw error;
    } finally { this.requests--; this.scheduleIdle(); }
  }
  async cancel(id: string) {
    if (this.origin) await this.request('/v1/tasks/' + encodeURIComponent(id) + '/cancel', { method: 'POST', signal: AbortSignal.timeout(1000) }).catch(() => {});
    await this.stop();
  }
  async stop() {
    clearTimeout(this.idle);
    const child = this.child; this.child = undefined; this.starting = undefined; this.origin = '';
    if (!child || !child.pid || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(timeout); resolve(); }); child.kill('SIGTERM');
    });
  }
}
