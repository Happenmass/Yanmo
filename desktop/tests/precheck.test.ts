import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRuntime } from '../precheck';
import { defaultAcpmInfo, defaultSettings } from '../shared';

test('状态判定：AcpmRuntime 未连接与待安装状态', () => {
  const online = defaultSettings().online;
  assert.equal(decideRuntime(online).status, 'checking');
  assert.deepEqual(decideRuntime(online).capabilities, { asr: 'unavailable', text: 'unavailable' });

  const disconnected = { ...defaultAcpmInfo('local'), error: '未检测到运行中的 AcpmRuntime。' };
  const resDisconnected = decideRuntime(online, disconnected);
  assert.equal(resDisconnected.status, 'acpm-disconnected');
  assert.deepEqual(resDisconnected.issues, ['未检测到运行中的 AcpmRuntime。']);

  const connectedMissing = { ...defaultAcpmInfo('local'), connected: true, asrReady: false, textReady: false };
  const resPending = decideRuntime(online, connectedMissing);
  assert.equal(resPending.status, 'models-pending');
  assert.match(resPending.issues[0], /尚未安装/);
});

test('状态判定：AcpmRuntime 与在线覆盖可独立或组合就绪', () => {
  const online = defaultSettings().online;

  const asrOnly = { ...defaultAcpmInfo('local'), connected: true, asrReady: true, textReady: false };
  const resAsr = decideRuntime(online, asrOnly);
  assert.equal(resAsr.status, 'asr-ready');
  assert.deepEqual(resAsr.capabilities, { asr: 'acpm', text: 'unavailable' });

  const fullAcpm = { ...defaultAcpmInfo('local'), connected: true, asrReady: true, textReady: true, vadReady: true };
  const resReady = decideRuntime(online, fullAcpm);
  assert.equal(resReady.status, 'ready');
  assert.deepEqual(resReady.capabilities, { asr: 'acpm', text: 'acpm' });
  assert.deepEqual(resReady.issues, []);

  // Online overrides take priority even when AcpmRuntime is disconnected.
  const disconnected = defaultAcpmInfo('local');
  const onlineAsrOnly = { ...online, asr: { enabled: true, baseURL: 'https://api.example.test/v1', model: 'whisper-1' } };
  assert.equal(decideRuntime(onlineAsrOnly, disconnected).status, 'asr-ready');
  assert.deepEqual(decideRuntime(onlineAsrOnly, disconnected).capabilities, { asr: 'online', text: 'unavailable' });

  const onlineBoth = { ...onlineAsrOnly, text: { enabled: true, baseURL: 'https://api.example.test/v1', model: 'qwen-plus' } };
  assert.equal(decideRuntime(onlineBoth, disconnected).status, 'ready');
  assert.deepEqual(decideRuntime(onlineBoth, disconnected).capabilities, { asr: 'online', text: 'online' });

  // Mixed: AcpmRuntime ASR + Online Text, or Online ASR + AcpmRuntime Text.
  const onlineTextOnly = { ...online, text: { enabled: true, baseURL: 'https://api.example.test/v1', model: 'qwen-plus' } };
  assert.deepEqual(decideRuntime(onlineTextOnly, asrOnly).capabilities, { asr: 'acpm', text: 'online' });
  assert.equal(decideRuntime(onlineTextOnly, asrOnly).status, 'ready');
});
