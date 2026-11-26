import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

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

// AcpmRuntime enforces a 128 MB HTTP body limit; keep raw WAV under 120 MB for multipart framing.
export const maxAudioBytes = 120 * 1024 * 1024;
export type TaskAudio = string | Buffer<ArrayBuffer>;
