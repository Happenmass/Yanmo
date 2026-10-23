import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Run } from '../precheck';
import { checkWindowsModels, downloadVerified, prepareWindowsRuntime, Stream, windowsToWSL, wslPrepareModels } from '../windows-runtime';

// A synthetic Windows machine whose WSL state advances as setup runs.
function machine(state: { gpu?: string; wsl: boolean; imported: boolean; provisioned: boolean; provisionError?: string }) {
  const calls: string[][] = [];
  const run: Run = async (file, args) => {
    calls.push([file, ...args]);
    const key = file + ' ' + args[0];
    if (key.startsWith('nvidia-smi')) return { ok: true, stdout: state.gpu ?? 'NVIDIA GeForce RTX 4060, 8188, 8.9\n' };
    if (key === 'wsl.exe --status') return { ok: state.wsl, stdout: '' };
    if (key === 'powershell.exe -NoProfile') return { ok: true, stdout: '' };
    if (key === 'wsl.exe --list') return { ok: true, stdout: '  NAME    STATE    VERSION\n* Ubuntu  Running  2\n' + (state.imported ? '  Yanmo   Stopped  2\n' : '') };
    if (key === 'wsl.exe --import') { state.imported = true; return { ok: true, stdout: '' }; }
    if (key === 'wsl.exe --distribution') return state.provisioned ? { ok: true, stdout: '{"cuda": true}\n' } : { ok: false, stdout: '' };
    return { ok: false, stdout: '' };
  };
  const stream: Stream = async (file, args, onLine) => {
    calls.push([file, ...args]);
    for (const step of ['system', 'packages', 'done']) onLine(JSON.stringify({ event: 'step', step }));
    if (state.provisionError) { onLine(JSON.stringify({ event: 'error', message: state.provisionError })); return false; }
    state.provisioned = true; return true;
  };
  return { run, stream, calls };
}
const temporary = () => mkdtempSync(join(tmpdir(), 'yanmo-wsl-'));

test('不支持的 GPU 不安装任何组件', async () => {
  const value = machine({ gpu: 'GTX 1060, 6144, 6.1\n', wsl: false, imported: false, provisioned: false });
  await assert.rejects(prepareWindowsRuntime({ ...value, cpu: 'x64', root: 'C:\\Yanmo', dataDir: temporary() }, () => {}), /6\.1.*在线/);
  assert.ok(value.calls.every(call => call[0] === 'nvidia-smi'));
});

test('未启用 WSL 时经 UAC 安装并要求重启，不下载系统镜像', async () => {
  const value = machine({ wsl: false, imported: false, provisioned: false });
  assert.equal(await prepareWindowsRuntime({ ...value, cpu: 'x64', root: 'C:\\Yanmo', dataDir: temporary(), fetch: async () => { throw new Error('不应下载'); } }, () => {}), 'reboot');
  const install = value.calls.find(call => call[0] === 'powershell.exe')!;
  assert.match(install.at(-1)!, /-Verb RunAs/); assert.match(install.at(-1)!, /'--install','--no-distribution'/);
  assert.ok(!value.calls.some(call => call[1] === '--import'));
});

test('导入专用发行版、以 root 运行安装脚本、验证后就绪，并删除镜像', async () => {
  const value = machine({ wsl: true, imported: false, provisioned: false });
  const dataDir = temporary(); const rootfs = join(dataDir, 'ubuntu-noble.rootfs.tar.gz'); writeFileSync(rootfs, 'synthetic');
  const progress: string[] = [];
  try {
    assert.equal(await prepareWindowsRuntime({ ...value, cpu: 'x64', root: 'C:\\Yanmo', dataDir }, message => progress.push(message)), 'ready');
    assert.deepEqual(value.calls.find(call => call[1] === '--import'), ['wsl.exe', '--import', 'Yanmo', join(dataDir, 'Yanmo'), rootfs, '--version', '2']);
    const provision = value.calls.find(call => call.includes('provision.sh'))!;
    assert.deepEqual(provision.slice(1, 7), ['--distribution', 'Yanmo', '--user', 'root', '--cd', join('C:\\Yanmo', 'runtime', 'windows')]);
    assert.ok(!existsSync(rootfs));
    assert.ok(progress.some(message => message.includes('4 GB')));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('已就绪时不重复安装；安装脚本的错误原样报告', async () => {
  const ready = machine({ wsl: true, imported: true, provisioned: true });
  assert.equal(await prepareWindowsRuntime({ ...ready, cpu: 'x64', root: 'C:\\Yanmo', dataDir: temporary() }, () => {}), 'ready');
  assert.ok(!ready.calls.some(call => call[1] === '--import' || call.includes('provision.sh')));
  const failing = machine({ wsl: true, imported: true, provisioned: false, provisionError: '运行库下载失败，请检查网络后重试。' });
  await assert.rejects(prepareWindowsRuntime({ ...failing, cpu: 'x64', root: 'C:\\Yanmo', dataDir: temporary() }, () => {}), /运行库下载失败/);
});

test('镜像下载：失败换源、断点续传、校验不符丢弃', async () => {
  const content = Buffer.from('synthetic rootfs '.repeat(1000)); const digest = createHash('sha256').update(content).digest('hex');
  const directory = temporary(); const destination = join(directory, 'rootfs.tar.gz');
  try {
    const ranges: (string | null)[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range'); ranges.push(range);
      if (url === 'bad') return new Response('', { status: 503 });
      if (range) { const start = Number(/bytes=(\d+)-/.exec(range)![1]); return new Response(content.subarray(start), { status: 206 }); }
      return new Response(content, { status: 200 });
    };
    writeFileSync(destination + '.part', content.subarray(0, 4000));
    await downloadVerified(['bad', 'good'], destination, digest, () => {}, fetcher);
    assert.deepEqual(ranges, ['bytes=4000-', 'bytes=4000-']);
    assert.deepEqual(readFileSync(destination), content); assert.ok(!existsSync(destination + '.part'));
    rmSync(destination);
    await assert.rejects(downloadVerified(['good'], destination, 'f'.repeat(64), () => {}, fetcher), /校验不符/);
    assert.ok(!existsSync(destination) && !existsSync(destination + '.part'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('模型在 WSL 内准备到 Windows 用户全局缓存，不准备 SenseVoice', async () => {
  assert.equal(windowsToWSL('C:\\Users\\言墨\\.cache\\codex\\models\\modelscope'), '/mnt/c/Users/言墨/.cache/codex/models/modelscope');
  assert.throws(() => windowsToWSL('\\\\server\\share'));
  const [file, args] = wslPrepareModels('C:\\Program Files\\言墨\\resources', 'C:\\Users\\u', ['--asr', 'a']);
  assert.equal(file, 'wsl.exe');
  assert.deepEqual(args.slice(0, 4), ['--distribution', 'Yanmo', '--cd', 'C:\\Program Files\\言墨\\resources']);
  assert.ok(args.includes('--without-sensevoice'));
  assert.ok(args.some(arg => arg.startsWith('MODELSCOPE_CACHE=/mnt/c/Users/u/') && arg.endsWith('/models/modelscope')));
  const stream: Stream = async (_file, _args, onLine) => { onLine('noise'); onLine('{"event":"checked","model":"asr-id","ready":true}'); onLine('{"event":"checked","model":"llm-id","ready":false}'); return true; };
  assert.deepEqual(await checkWindowsModels('C:\\r', 'C:\\Users\\u', { modelSource: 'modelscope', asrModel: 'asr-id', llmModel: 'llm-id' }, stream), { asr: true, llm: false });
});
