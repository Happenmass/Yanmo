// Windows local runtime: a venv with PyTorch CUDA and transformers, built by runtime/windows/setup_runtime.py.
// See docs/architecture/electron_01_Runtime_运行时与预检查.md §8.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { probeWindows, Run } from './precheck';

const STEPS: Record<string, string> = { venv: '正在创建本地运行环境…', packages: '正在下载并安装 PyTorch 与 CUDA 运行库（约 2.1 GB）…', done: '运行库已安装，正在验证 CUDA…' };

/** Streams a command's stdout lines; resolves whether it exited successfully. */
export type Stream = (file: string, args: string[], onLine: (line: string) => void, cwd?: string) => Promise<boolean>;
export const streamCommand: Stream = (file, args, onLine, cwd) => new Promise(resolve => {
  const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  createInterface({ input: child.stdout }).on('line', onLine);
  child.stderr.resume();
  child.once('error', () => resolve(false));
  child.once('close', code => resolve(code === 0));
});

export interface RuntimePaths { dir: string; python: string; lock: string; setup: string }
/** dataDir is %LOCALAPPDATA%\Yanmo; root holds runtime/windows from the app resources. */
export function runtimePaths(dataDir: string, root: string): RuntimePaths {
  const dir = join(dataDir, 'runtime');
  return { dir, python: join(dir, 'Scripts', 'python.exe'), lock: join(root, 'runtime', 'windows', 'requirements.lock'), setup: join(root, 'runtime', 'windows', 'setup_runtime.py') };
}
/** True when setup_runtime.py finished against the lock this app ships. */
export function runtimeCurrent(paths: RuntimePaths) {
  const marker = join(paths.dir, 'lock.sha256');
  if (!existsSync(marker) || !existsSync(paths.python)) return false;
  return readFileSync(marker, 'utf8').trim() === createHash('sha256').update(readFileSync(paths.lock)).digest('hex');
}

let running = false;
export const setupRunning = () => running;

/** gatewayPython is the bundled Python; it creates the venv. */
export async function prepareWindowsRuntime(paths: RuntimePaths, gatewayPython: string, onProgress: (message: string) => void, deps: { run?: Run; stream?: Stream; cpu?: string } = {}) {
  const stream = deps.stream ?? streamCommand;
  if (running) throw new Error('运行环境正在准备中。');
  running = true;
  try {
    onProgress('正在检查本机环境…');
    const probe = () => probeWindows({ python: paths.python, current: runtimeCurrent(paths) }, deps.run, deps.cpu);
    const environment = await probe();
    if (environment.environment === 'ready') return;
    if (environment.environment === 'unsupported') throw new Error(environment.issues.join(' ') + ' 建议在设置中配置在线处理。');
    let error = '';
    const installed = await stream(gatewayPython, ['-B', paths.setup, paths.dir, paths.lock], line => {
      try {
        const value = JSON.parse(line);
        if (value.event === 'step' && STEPS[value.step]) onProgress(STEPS[value.step]);
        if (value.event === 'error') error = String(value.message);
      } catch { /* Only JSON progress lines are shown. */ }
    });
    if (!installed) throw new Error(error || '运行库安装未完成，请重试；已下载的部分会继续使用。');
    const verified = await probe();
    if (verified.environment !== 'ready') throw new Error(verified.issues.join(' '));
  } finally { running = false; }
}

export async function checkWindowsModels(paths: RuntimePaths, root: string, settings: { modelSource: string; asrModel: string; llmModel: string }, stream: Stream = streamCommand) {
  const ready = new Set<string>();
  await stream(paths.python, ['-B', '-m', 'backend.prepare_models', '--check', '--without-sensevoice', '--source', settings.modelSource, '--asr', settings.asrModel, '--llm', settings.llmModel],
    line => { try { const value = JSON.parse(line); if (value.event === 'checked' && value.ready === true) ready.add(value.model); } catch { /* Not a protocol line. */ } }, root);
  return { asr: ready.has(settings.asrModel), llm: ready.has(settings.llmModel) };
}
