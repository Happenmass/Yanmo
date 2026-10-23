// Windows local environment setup (WSL2 + dedicated Yanmo distro) and the WSL commands that prepare CUDA models.
// See docs/architecture/electron_01_Runtime_运行时与预检查.md §8.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { parseDistros, probeWindows, Run, runCommand, WSL_DISTRO, WSL_PYTHON } from './precheck';

const ROOTFS_PATH = 'ubuntu-cloud-images/wsl/releases/24.04/20240423/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz';
export const ROOTFS = {
  sha256: '8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea',
  // Mainland mirrors first, then Ubuntu's own server.
  urls: ['https://mirrors.ustc.edu.cn/' + ROOTFS_PATH, 'https://mirror.nju.edu.cn/' + ROOTFS_PATH, 'https://cloud-images.ubuntu.com/' + ROOTFS_PATH.replace('ubuntu-cloud-images/', '')],
};
const STEPS: Record<string, string> = { system: '正在安装系统组件…', packages: '正在下载并安装 vLLM 与 CUDA 运行库（约 4 GB）…', done: '运行库已安装，正在验证 CUDA…' };

/** Streams a command's stdout lines; resolves whether it exited successfully. */
export type Stream = (file: string, args: string[], onLine: (line: string) => void) => Promise<boolean>;
export const streamCommand: Stream = (file, args, onLine) => new Promise(resolve => {
  const child = spawn(file, args, { windowsHide: true, env: { ...process.env, WSL_UTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  createInterface({ input: child.stdout }).on('line', onLine);
  child.stderr.resume();
  child.once('error', () => resolve(false));
  child.once('close', code => resolve(code === 0));
});

// Electron's net.fetch is passed in so downloads follow the system proxy.
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface SetupDeps { run?: Run; stream?: Stream; fetch?: Fetch; cpu?: string; root: string; dataDir: string }

export function windowsToWSL(path: string) {
  const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(path);
  if (!match) throw new Error('无法映射到 WSL 的路径：' + path);
  return '/mnt/' + match[1].toLowerCase() + '/' + match[2].replace(/\\/g, '/').replace(/\/+$/, '');
}

async function sha256(path: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
/** Tries each mirror in order, resuming a partial download; a checksum mismatch discards it and moves on. */
export async function downloadVerified(urls: string[], destination: string, digest: string, onProgress: (fraction: number) => void, fetcher: Fetch = fetch) {
  const part = destination + '.part';
  for (const url of urls) {
    try {
      const offset = existsSync(part) ? statSync(part).size : 0;
      const response = await fetcher(url, { headers: offset ? { Range: `bytes=${offset}-` } : {} });
      if (response.status === 416) rmSync(part, { force: true });
      if (!response.ok || !response.body) continue;
      const append = response.status === 206;
      const total = Number(response.headers.get('content-length') || 0) + (append ? offset : 0);
      let received = append ? offset : 0;
      await pipeline(Readable.fromWeb(response.body as any), async function* (source) {
        for await (const chunk of source) { received += chunk.length; if (total) onProgress(received / total); yield chunk; }
      }, createWriteStream(part, { flags: append ? 'a' : 'w' }));
      if (await sha256(part) === digest) { renameSync(part, destination); return; }
      rmSync(part, { force: true });
    } catch { /* Try the next source; a partial file is kept for resuming. */ }
  }
  throw new Error('系统镜像下载失败或校验不符，请检查网络后重试。');
}

/** Elevated `wsl --install --no-distribution`; the UAC prompt is the user's confirmation. */
const INSTALL_WSL = "$p = Start-Process -FilePath 'wsl.exe' -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait -PassThru; exit $p.ExitCode";

let running = false;
export const setupRunning = () => running;

/** Returns 'reboot' after enabling WSL (the user restarts, then runs setup again), otherwise 'ready'. */
export async function prepareWindowsRuntime(deps: SetupDeps, onProgress: (message: string) => void): Promise<'ready' | 'reboot'> {
  const run = deps.run ?? runCommand; const stream = deps.stream ?? streamCommand;
  if (running) throw new Error('运行环境正在准备中。');
  running = true;
  try {
    onProgress('正在检查本机环境…');
    const environment = await probeWindows(run, deps.cpu);
    if (environment.environment === 'ready') return 'ready';
    if (environment.environment === 'unsupported') throw new Error(environment.issues.join(' ') + ' 建议在设置中配置在线处理。');
    if (!(await run('wsl.exe', ['--status'], 30000)).ok) {
      onProgress('正在启用 WSL2，请在系统弹窗中允许…');
      if (!(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', INSTALL_WSL], 1800000)).ok) throw new Error('WSL2 未能启用，可能是取消了系统授权，或需要在 BIOS 中开启虚拟化。');
      return 'reboot';
    }
    const list = await run('wsl.exe', ['--list', '--verbose'], 30000);
    const distro = list.ok ? parseDistros(list.stdout).find(item => item.name === WSL_DISTRO) : undefined;
    if (distro && distro.version !== 2) throw new Error('已有名为 Yanmo 的 WSL 1 发行版，请先在终端运行 wsl --set-version Yanmo 2。');
    if (!distro) {
      mkdirSync(deps.dataDir, { recursive: true });
      const rootfs = join(deps.dataDir, 'ubuntu-noble.rootfs.tar.gz');
      let shown = -1;
      if (!existsSync(rootfs)) await downloadVerified(ROOTFS.urls, rootfs, ROOTFS.sha256, fraction => {
        const percent = Math.floor(fraction * 100);
        if (percent !== shown) { shown = percent; onProgress(`正在下载 Ubuntu 系统镜像（${percent}%）…`); }
      }, deps.fetch);
      onProgress('正在导入言墨专用 WSL 环境…');
      const imported = await run('wsl.exe', ['--import', WSL_DISTRO, join(deps.dataDir, WSL_DISTRO), rootfs, '--version', '2'], 600000);
      if (!imported.ok) throw new Error('导入 WSL 环境失败：' + (imported.stdout.trim() || '请确认已开启虚拟化后重试。'));
      rmSync(rootfs, { force: true });
    }
    let error = '';
    const provisioned = await stream('wsl.exe', ['--distribution', WSL_DISTRO, '--user', 'root', '--cd', join(deps.root, 'runtime', 'windows'), '--exec', '/bin/bash', 'provision.sh', 'wsl-requirements.lock'], line => {
      try {
        const value = JSON.parse(line);
        if (value.event === 'step' && STEPS[value.step]) onProgress(STEPS[value.step]);
        if (value.event === 'error') error = String(value.message);
      } catch { /* Only JSON progress lines are shown. */ }
    });
    if (!provisioned) throw new Error(error || '运行库安装未完成，请重试；已下载的部分会继续使用。');
    const verified = await probeWindows(run, deps.cpu);
    if (verified.environment !== 'ready') throw new Error(verified.issues.join(' '));
    return 'ready';
  } finally { running = false; }
}

/** wsl.exe invocation of backend.prepare_models inside the Yanmo distro, writing to the Windows user cache. */
export function wslPrepareModels(root: string, home: string, args: string[]): [string, string[]] {
  const cache = process.env.MODELSCOPE_CACHE || join(home, '.cache', 'codex', 'models', 'modelscope');
  return ['wsl.exe', ['--distribution', WSL_DISTRO, '--cd', root, '--exec', '/usr/bin/env',
    'MODELSCOPE_CACHE=' + windowsToWSL(cache), 'HF_HOME=' + windowsToWSL(join(home, '.cache', 'huggingface')), 'HF_HUB_DISABLE_TELEMETRY=1', 'PYTHONUNBUFFERED=1',
    WSL_PYTHON, '-B', '-u', '-m', 'backend.prepare_models', '--without-sensevoice', ...args]];
}

export async function checkWindowsModels(root: string, home: string, settings: { modelSource: string; asrModel: string; llmModel: string }, stream: Stream = streamCommand) {
  const [file, args] = wslPrepareModels(root, home, ['--check', '--source', settings.modelSource, '--asr', settings.asrModel, '--llm', settings.llmModel]);
  const ready = new Set<string>();
  await stream(file, args, line => { try { const value = JSON.parse(line); if (value.event === 'checked' && value.ready === true) ready.add(value.model); } catch { /* Not a protocol line. */ } });
  return { asr: ready.has(settings.asrModel), llm: ready.has(settings.llmModel) };
}
