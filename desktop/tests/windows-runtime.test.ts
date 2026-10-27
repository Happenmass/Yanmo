import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Run } from '../precheck';
import { checkWindowsModels, prepareWindowsRuntime, runtimeCurrent, runtimePaths, Stream } from '../windows-runtime';

// A synthetic Windows machine: setup_runtime.py "installs" by writing the venv Python and marker.
function machine(options: { gpu?: string; failSetup?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yanmo-win-'));
  const paths = runtimePaths(join(root, 'Local', 'Yanmo'), root);
  mkdirSync(join(root, 'runtime', 'windows'), { recursive: true });
  writeFileSync(paths.lock, 'torch==2.14.1+cu130 --hash=sha256:00\n');
  const calls: string[][] = [];
  const run: Run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'nvidia-smi') return { ok: true, stdout: options.gpu ?? 'NVIDIA GeForce RTX 4060, 8188, 8.9\n' };
    if (file === paths.python) return { ok: true, stdout: '{"cuda": true}\n' };
    return { ok: false, stdout: '' };
  };
  const stream: Stream = async (file, args, onLine) => {
    calls.push([file, ...args]);
    for (const step of ['venv', 'packages']) onLine(JSON.stringify({ event: 'step', step }));
    if (options.failSetup) { onLine(JSON.stringify({ event: 'error', message: options.failSetup })); return false; }
    mkdirSync(join(paths.dir, 'Scripts'), { recursive: true }); writeFileSync(paths.python, '');
    writeFileSync(join(paths.dir, 'lock.sha256'), createHash('sha256').update('torch==2.14.1+cu130 --hash=sha256:00\n').digest('hex'));
    onLine(JSON.stringify({ event: 'step', step: 'done' })); return true;
  };
  return { root, paths, run, stream, calls, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('不支持的 GPU 不安装任何组件', async () => {
  const value = machine({ gpu: 'GTX 1060, 6144, 6.1\n' });
  try {
    await assert.rejects(prepareWindowsRuntime(value.paths, 'gateway.exe', () => {}, { ...value, cpu: 'x64' }), /6\.1.*在线/);
    assert.ok(value.calls.every(call => call[0] === 'nvidia-smi'));
  } finally { value.close(); }
});

test('以内置 Python 运行安装脚本，验证 CUDA 后就绪；再次准备不重复安装', async () => {
  const value = machine(); const progress: string[] = [];
  try {
    assert.equal(runtimeCurrent(value.paths), false);
    await prepareWindowsRuntime(value.paths, 'gateway.exe', message => progress.push(message), { ...value, cpu: 'x64' });
    assert.deepEqual(value.calls.find(call => call[0] === 'gateway.exe'), ['gateway.exe', '-B', value.paths.setup, value.paths.dir, value.paths.lock]);
    assert.ok(progress.some(message => message.includes('2.1 GB')));
    assert.equal(runtimeCurrent(value.paths), true);
    const before = value.calls.length;
    await prepareWindowsRuntime(value.paths, 'gateway.exe', () => {}, { ...value, cpu: 'x64' });
    assert.ok(!value.calls.slice(before).some(call => call[0] === 'gateway.exe'));
    // A newer shipped lock makes the installed runtime stale.
    writeFileSync(value.paths.lock, 'torch==2.15.0+cu130 --hash=sha256:01\n');
    assert.equal(runtimeCurrent(value.paths), false);
  } finally { value.close(); }
});

test('安装脚本的错误原样报告', async () => {
  const value = machine({ failSetup: '运行库下载失败，请检查网络后重试；已下载的部分会继续使用。' });
  try { await assert.rejects(prepareWindowsRuntime(value.paths, 'gateway.exe', () => {}, { ...value, cpu: 'x64' }), /运行库下载失败/); }
  finally { value.close(); }
});

test('模型检查用运行库 Python，在应用资源目录运行且不检查 SenseVoice', async () => {
  const paths = runtimePaths('C:\\Users\\u\\AppData\\Local\\Yanmo', 'C:\\r');
  let seen: { file: string; args: string[]; cwd?: string } | undefined;
  const stream: Stream = async (file, args, onLine, cwd) => { seen = { file, args, cwd }; onLine('noise'); onLine('{"event":"checked","model":"asr-id","ready":true}'); onLine('{"event":"checked","model":"llm-id","ready":false}'); return true; };
  assert.deepEqual(await checkWindowsModels(paths, 'C:\\r', { modelSource: 'modelscope', asrModel: 'asr-id', llmModel: 'llm-id' }, stream), { asr: true, llm: false });
  assert.equal(seen!.file, paths.python); assert.equal(seen!.cwd, 'C:\\r');
  assert.ok(seen!.args.includes('--check') && seen!.args.includes('--without-sensevoice'));
});
