import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRuntime, decodeOutput, parseDistros, probeWindows, Run } from '../precheck';
import { defaultSettings } from '../shared';

const GPU = 'NVIDIA GeForce RTX 4070, 12282, 8.9\n';
const DISTROS = '  NAME      STATE           VERSION\n* Ubuntu    Running         2\n  Yanmo     Stopped         2\n';
const CUDA = 'warning from a library\n{"cuda": true, "device": "NVIDIA GeForce RTX 4070", "vllm": "0.0.0"}\n';
// Synthetic command outputs keyed by "file first-arg"; anything absent fails.
function machine(outputs: Record<string, string | { missing: true }>): Run {
  return async (file, args) => {
    const value = outputs[file + ' ' + args[0]];
    if (value === undefined) return { ok: false, stdout: '' };
    if (typeof value === 'object') return { ok: false, missing: true, stdout: '' };
    return { ok: true, stdout: value };
  };
}
const ready = { 'nvidia-smi --query-gpu=name,memory.total,compute_cap': GPU, 'wsl.exe --status': '', 'wsl.exe --list': DISTROS, 'wsl.exe --distribution': CUDA };

test('Windows 预检查按步骤给出可操作结论', async () => {
  const cases: [string, Run, string, string, string?][] = [
    ['非 x64', machine(ready), 'arm64', 'unsupported', 'x64'],
    ['无 NVIDIA 驱动', machine({ ...ready, 'nvidia-smi --query-gpu=name,memory.total,compute_cap': { missing: true } }), 'x64', 'unsupported', 'NVIDIA'],
    ['算力不足', machine({ ...ready, 'nvidia-smi --query-gpu=name,memory.total,compute_cap': 'NVIDIA GeForce GTX 1060, 6144, 6.1\n' }), 'x64', 'unsupported', '6.1'],
    ['Volta 不受 CUDA 13 支持', machine({ ...ready, 'nvidia-smi --query-gpu=name,memory.total,compute_cap': 'Tesla V100, 16384, 7.0\n' }), 'x64', 'unsupported', '7.5'],
    ['WSL 未启用', machine({ ...ready, 'wsl.exe --status': undefined as unknown as string }), 'x64', 'repair', 'wsl --install'],
    ['无言墨发行版', machine({ ...ready, 'wsl.exe --list': '  NAME   STATE    VERSION\n* Ubuntu Running  2\n' }), 'x64', 'repair', '尚未安装'],
    ['言墨发行版为 WSL1', machine({ ...ready, 'wsl.exe --list': '  NAME  STATE   VERSION\n  Yanmo Stopped 1\n' }), 'x64', 'repair', 'WSL 2'],
    ['WSL 内 CUDA 不可用', machine({ ...ready, 'wsl.exe --distribution': '{"cuda": false}\n' }), 'x64', 'repair', 'CUDA'],
    ['WSL 内探测失败', machine({ ...ready, 'wsl.exe --distribution': undefined as unknown as string }), 'x64', 'repair', 'CUDA'],
    ['全部通过', machine(ready), 'x64', 'ready'],
  ];
  for (const [name, run, cpu, environment, issue] of cases) {
    const result = await probeWindows(run, cpu);
    assert.equal(result.environment, environment, name);
    if (issue) assert.match(result.issues.join(), new RegExp(issue), name);
    else assert.deepEqual(result.issues, [], name);
  }
  assert.equal((await probeWindows(machine(ready), 'x64')).gpu, 'NVIDIA GeForce RTX 4070 · 12 GB');
});

test('旧驱动不支持 compute_cap 时退回只查名称与显存，由 WSL 内 CUDA 决定', async () => {
  const run = machine({ ...ready, 'nvidia-smi --query-gpu=name,memory.total,compute_cap': undefined as unknown as string, 'nvidia-smi --query-gpu=name,memory.total': 'Quadro RTX 5000, 16384\n' });
  assert.equal((await probeWindows(run, 'x64')).environment, 'ready');
});

test('多块 GPU 取符合算力要求中显存最大者', async () => {
  const run = machine({ ...ready, 'nvidia-smi --query-gpu=name,memory.total,compute_cap': 'GTX 1080 Ti, 11264, 6.1\nRTX 3060, 12288, 8.6\nRTX 3050, 8192, 8.6\n' });
  assert.equal((await probeWindows(run, 'x64')).gpu, 'RTX 3060 · 12 GB');
});

test('wsl.exe 的 UTF-16 输出与本地化表头均可解析', () => {
  const localized = '  名称      状态           版本\r\n* Yanmo     已停止         2\r\n';
  assert.deepEqual(parseDistros(decodeOutput(Buffer.from('﻿' + localized, 'utf16le'))), [{ name: 'Yanmo', version: 2 }]);
  assert.equal(decodeOutput(Buffer.from('plain', 'utf8')), 'plain');
});

test('状态判定：无 CUDA 推荐在线，配置一项为 API 待配置，两项为在线可用', () => {
  const online = defaultSettings().online; const none = { asr: false, text: false };
  const unsupported = { environment: 'unsupported' as const, issues: ['未检测到 NVIDIA GPU 或驱动。'] };
  assert.equal(decideRuntime(online, none).status, 'checking');
  assert.equal(decideRuntime(online, none, unsupported).status, 'recommend-online');
  const text = { ...online, text: { enabled: true, baseURL: 'https://api.example.test/v1', model: 'm' } };
  const partial = decideRuntime(text, none, unsupported);
  assert.equal(partial.status, 'api-pending'); assert.deepEqual(partial.capabilities, { asr: 'unavailable', text: 'online' });
  const both = { ...text, asr: { enabled: true, baseURL: 'https://api.example.test/v1', model: 'a' } };
  assert.equal(decideRuntime(both, none, unsupported).status, 'online-ready');
  // An explicit online choice stands before the probe has finished.
  assert.equal(decideRuntime(both, none).status, 'online-ready');
});

test('状态判定：本地环境待修复、模型待准备与本地可用', () => {
  const online = defaultSettings().online;
  assert.equal(decideRuntime(online, { asr: true, text: true }, { environment: 'repair', issues: ['x'] }).status, 'local-repair');
  assert.equal(decideRuntime(online, { asr: false, text: true }, { environment: 'ready', issues: [] }).status, 'models-pending');
  const local = decideRuntime(online, { asr: true, text: true }, { environment: 'ready', issues: [] });
  assert.equal(local.status, 'local-ready'); assert.deepEqual(local.capabilities, { asr: 'local', text: 'local' });
  const mixed = decideRuntime({ ...online, text: { enabled: true, baseURL: 'https://api.example.test/v1', model: 'm' } }, { asr: true, text: false }, { environment: 'ready', issues: [] });
  assert.equal(mixed.status, 'online-ready'); assert.deepEqual(mixed.capabilities, { asr: 'local', text: 'online' });
});
