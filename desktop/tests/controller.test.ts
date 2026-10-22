import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../controller';
import { LibraryStore } from '../store';
import { checkOnlineURL, defaultSettings, TaskEvent } from '../shared';
import { NativeBridge, BackendClient } from '../processes';

class Native extends EventEmitter {
  calls: string[] = [];
  arguments: { command: string; args: Record<string, unknown> }[] = [];
  async call(command: string, args: Record<string, unknown> = {}) { this.calls.push(command); this.arguments.push({ command, args }); if (['audio.import', 'record.finish'].includes(command)) return { path: '/synthetic.wav', seconds: 2 }; if (command === 'insert') return { delivery: 'attempted_unverified', name: '写入时的应用' }; return { accessibility: true, eventTap: true, microphone: 3, devices: [] }; }
  async start() {} stop() {}
}
class Backend {
  mode = 'failure'; done?: () => void;
  requests: any[] = [];
  setActive(_value: boolean) {} async stop() {} async status() { return {}; } async warmup() {}
  async run(request: any, _audio: unknown, emit: (event: TaskEvent) => void) {
    this.requests.push(request);
    const event = (value: Partial<TaskEvent>) => emit({ task_id: request.task_id, event: 'stage', ...value });
    if (request.operation === 'polish') { event({ event: 'result', text: request.context.user_text || request.text, processed: true }); return; }
    event({ event: 'transcript', text: '预算3500元，不是周四。' });
    if (this.mode === 'dual') {
      event({ stage: 'reviewing' });
      event({ event: 'transcript', text: '预算3500元，不是周四。', asr_results: [
        { engine_name: 'Qwen3-ASR', transcript: '预算3500元，不是周四。', language: 'Chinese', language_source: 'detected' },
        { engine_name: 'SenseVoice Small', transcript: '预算三千五百元，不是周四。', language: 'Chinese', language_source: 'forced' },
      ] });
      event({ event: 'result', text: '预算3500元，不是周四。', processed: true });
    } else if (this.mode === 'translation') {
      event({ event: 'result', text: 'I want to create a new animation effect.', processed: true });
    } else if (this.mode === 'processingFailure') {
      event({ event: 'transcript', text: '预算3500元，不是周四。', asr_results: [
        { engine_name: 'Qwen3-ASR', transcript: '预算3500元，不是周四。' },
        { engine_name: 'SenseVoice Small', transcript: '预算3501元，不是周四。' },
      ] });
      event({ event: 'error', message: '模拟推理失败' });
    } else if (this.mode === 'cancel') {
      await new Promise<void>(resolve => { this.done = resolve; });
      event({ event: 'result', text: '迟到的结果', processed: true });
    } else event({ event: 'error', message: '模拟整理失败', original: '预算3500元，不是周四。' });
  }
  async cancel() { this.done?.(); }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'yanmo-controller-')); const native = new Native(); const backend = new Backend();
  const controller = new Controller(new LibraryStore(directory, defaultSettings()), native as unknown as NativeBridge, backend as unknown as BackendClient);
  return { controller, native, backend, async close() { await controller.shutdown(); rmSync(directory, { recursive: true, force: true }); } };
}
test('输入框上下文不可读仍开始录音，不要求预先提供写入目标', async () => {
  const value = fixture(); value.backend.mode = 'dual';
  try {
    await value.controller.perform('dictation', {});
    assert.equal(value.controller.state.stage, 'recording');
    assert.ok(value.native.calls.includes('record.start'));
    assert.ok(!value.native.calls.includes('insert'));
    assert.equal(value.backend.requests.length, 0);
    assert.equal(value.controller.state.library.manuscripts.length, 0);
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.native.calls.filter(command => command === 'insert').length, 1);
    assert.equal(value.native.arguments.find(call => call.command === 'insert')?.args.destinationId, undefined);
  } finally { await value.close(); }
});
test('不公开输入控件的应用照常显示录音浮层，无上下文完成识别后只尝试写入一次', async () => {
  const value = fixture(); value.backend.mode = 'dual';
  try {
    await value.controller.updateSettings({ readContext: true });
    await value.controller.perform('dictation', { id: 'opaque-editor', name: '合成编辑器' });
    assert.equal(value.controller.state.stage, 'recording');
    assert.equal(value.controller.state.overlayVisible, true);
    assert.ok(value.native.calls.includes('record.start'));
    assert.equal(value.backend.requests.length, 0);
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.backend.requests[0].context.before, '');
    assert.equal(value.backend.requests[0].context.after, '');
    assert.equal(value.native.calls.filter(command => command === 'insert').length, 1);
    assert.equal(value.native.arguments.find(call => call.command === 'insert')?.args.destinationId, undefined);
    assert.equal(value.controller.state.destinationName, '写入时的应用');
    assert.equal(value.controller.state.library.manuscripts[0].application, '写入时的应用');
    assert.equal(value.controller.state.library.manuscripts.length, 1);
    assert.equal(value.controller.state.stage, 'idle');
    assert.match(value.controller.state.library.manuscripts[0].deliveryNote!, /当前输入位置/);
  } finally { await value.close(); }
});
test('口述翻译不需要预先绑定输入框，录音也不因起始焦点类型被阻止', async () => {
  const value = fixture();
  try {
    await value.controller.perform('voiceTranslation', {});
    assert.equal(value.controller.state.stage, 'recording');
    await value.controller.cancel();
    await value.controller.perform('dictation', { id: 'secure-field', secure: true });
    assert.equal(value.controller.state.stage, 'recording');
    assert.equal(value.native.calls.filter(command => command === 'record.start').length, 2);
  } finally { await value.close(); }
});
test('并发设置修改串行提交，不互相覆盖', async () => {
  const value = fixture();
  try {
    await Promise.all([value.controller.updateSettings({ voiceTarget: 'ja' }), value.controller.updateSettings({ selectionTarget: 'zh-Hans' }), value.controller.updateSettings({ style: '即时消息' })]);
    assert.equal(value.controller.state.settings.voiceTarget, 'ja'); assert.equal(value.controller.state.settings.selectionTarget, 'zh-Hans'); assert.equal(value.controller.state.settings.style, '即时消息');
    assert.equal(value.native.calls.filter(command => command === 'configure').length, 0);
  } finally { await value.close(); }
});
test('整理失败保留原文，绝不自动写入降级内容', async () => {
  const value = fixture();
  try {
    await value.controller.importAudio('/synthetic-input.wav');
    assert.equal(value.controller.state.library.manuscripts.length, 1);
    assert.equal(value.controller.state.draft, '预算3500元，不是周四。');
    assert.equal(value.controller.state.stage, 'failure'); assert.ok(!value.native.calls.includes('insert'));
    assert.ok(value.native.calls.includes('audio.delete'));
  } finally { await value.close(); }
});
test('取消后丢弃迟到的完成结果，原文只保存一次', async () => {
  const value = fixture(); value.backend.mode = 'cancel';
  try {
    const processing = value.controller.importAudio('/synthetic-input.wav');
    while (!value.backend.done) await new Promise(resolve => setTimeout(resolve, 1));
    await value.controller.cancel(); await processing;
    assert.equal(value.controller.state.draft, '预算3500元，不是周四。');
    assert.equal(value.controller.state.library.manuscripts.length, 1);
    assert.ok(!value.native.calls.includes('insert')); assert.equal(value.controller.state.stage, 'idle');
  } finally { await value.close(); }
});
test('两路识别的原文和语言随文稿保存，重启后可重新对照', async () => {
  const value = fixture(); value.backend.mode = 'dual';
  const stages: string[] = [];
  value.controller.on('state', state => stages.push(state.stage));
  try {
    await value.controller.importAudio('/synthetic-input.wav');
    assert.ok(!value.native.calls.includes('insert'), '导入音频只保留文稿，不自动粘贴到前台应用');
    assert.ok(stages.includes('reviewing'));
    const item = value.controller.state.library.manuscripts[0];
    assert.equal(item.original, '预算3500元，不是周四。');
    assert.deepEqual(item.asrResults?.map(result => result.engine_name), ['Qwen3-ASR', 'SenseVoice Small']);
    const store = new LibraryStore(value.controller.store.directory, defaultSettings());
    assert.equal(store.error, '');
    assert.deepEqual(store.library.manuscripts[0].asrResults, item.asrResults);
    value.controller.state.library = store.library;
    value.controller.select(item.id);
    assert.deepEqual(value.controller.state.asrResults, item.asrResults);
    assert.equal(value.controller.state.asrResults[0].language_source, 'detected');
    assert.equal(value.controller.state.asrResults[1].language_source, 'forced');
  } finally { await value.close(); }
});
test('再次整理带入两路历史，用户修改的正文优先且不覆盖原始识别', async () => {
  const value = fixture(); value.backend.mode = 'dual';
  try {
    await value.controller.importAudio('/synthetic-input.wav');
    const id = value.controller.state.selectedID!;
    await value.controller.polishDraft();
    assert.equal(value.backend.requests.at(-1).asr_results.length, 2);
    assert.equal(value.backend.requests.at(-1).context.user_text, undefined);
    value.controller.updateDraft(id, '预算4200元，不是周四。');
    await value.controller.polishDraft();
    assert.equal(value.backend.requests.at(-1).context.user_text, '预算4200元，不是周四。');
    assert.equal(value.controller.state.draft, '预算4200元，不是周四。');
    assert.equal(value.controller.state.library.manuscripts.length, 1);
    assert.equal(value.controller.state.original, '预算3500元，不是周四。');
  } finally { await value.close(); }
});
test('录音保留输入框上下文快照且受开关约束，后端失败保留诊断', async () => {
  const value = fixture(); value.backend.mode = 'processingFailure';
  try {
    await value.controller.updateSettings({ readContext: true });
    const before = '前' .repeat(350) + '金额3501元'; const after = '后文' + '后'.repeat(350);
    await value.controller.perform('dictation', { id: 'synthetic-target', before, after });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.backend.requests[0].context.before, before.slice(-300));
    assert.equal(value.backend.requests[0].context.after, after.slice(0, 300));
    assert.ok(!value.native.calls.includes('insert'));
    const store = new LibraryStore(value.controller.store.directory, defaultSettings());
    assert.equal(store.library.manuscripts[0].original, '预算3500元，不是周四。');
    await value.controller.updateSettings({ readContext: false });
    await value.controller.perform('dictation', { id: 'synthetic-target', before, after });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.backend.requests[1].context.before, '');
    assert.equal(value.backend.requests[1].context.after, '');
  } finally { await value.close(); }
});
test('口述译文直接保存并向写入时焦点粘贴一次', async () => {
  const value = fixture(); value.backend.mode = 'translation';
  try {
    await value.controller.perform('voiceTranslation', { id: 'initial-context', name: '起始应用' });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.backend.requests[0].operation, 'voiceTranslation');
    assert.equal(value.backend.requests[0].target_language, 'en');
    const calls = value.native.arguments.filter(call => call.command === 'insert');
    assert.deepEqual(calls, [{ command: 'insert', args: { text: 'I want to create a new animation effect.' } }]);
    assert.equal(value.controller.state.stage, 'idle');
    assert.equal(value.controller.state.draft, 'I want to create a new animation effect.');
    assert.equal(value.controller.state.library.manuscripts[0].text, 'I want to create a new animation effect.');
  } finally { await value.close(); }
});
test('划词翻译可读取言墨自身窗口的选区，空选区仍提示先选中', async () => {
  const value = fixture(); value.backend.mode = 'translation';
  try {
    await value.controller.perform('selectionTranslation', {});
    assert.match(value.controller.state.translation.error, /请先选中文字/);
    value.controller.ownSelection = async () => '  Please bring the draft notes  ';
    await value.controller.perform('selectionTranslation', {});
    assert.equal(value.controller.state.translation.source, 'Please bring the draft notes');
    assert.equal(value.backend.requests.at(-1).operation, 'selectionTranslation');
    assert.equal(value.controller.state.translation.result, 'I want to create a new animation effect.');
    assert.ok(!value.native.calls.includes('selection'));
  } finally { await value.close(); }
});
test('语音输入键可结束口述翻译录音', async () => {
  const value = fixture();
  try {
    value.native.emit('shortcut', { action: 'voiceTranslation', destination: {} });
    while (value.controller.state.stage !== 'recording') await new Promise(resolve => setTimeout(resolve, 1));
    value.native.emit('shortcut', { action: 'selectionTranslation', destination: {} });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(value.controller.state.stage, 'recording');
    value.native.emit('shortcut', { action: 'dictation', destination: {} });
    while (!value.native.calls.includes('record.finish')) await new Promise(resolve => setTimeout(resolve, 1));
  } finally { await value.close(); }
});
test('在线模型只在启用时随任务发送，地址需 https 或本机', async () => {
  for (const bad of ['http://api.example.com/v1', 'https://user:pw@api.example.com', 'https://api.example.com/v1?key=x', 'ftp://x']) assert.throws(() => checkOnlineURL(bad));
  for (const good of ['https://api.example.com/v1', 'http://127.0.0.1:8000/v1', 'http://localhost:11434/v1']) checkOnlineURL(good);
  const value = fixture(); const requests: any[] = [];
  const run = value.backend.run.bind(value.backend);
  value.backend.run = async (request: any, audio: unknown, emit: any) => { requests.push(request); return run(request, audio, emit); };
  try {
    await value.controller.importAudio('/synthetic-input.wav');
    assert.deepEqual(requests[0].online, {});
    await assert.rejects(value.controller.updateSettings({ online: { ...defaultSettings().online, text: { enabled: true, baseURL: '', model: '' } } }));
    value.controller.setOnlineKeys({ text: 'sk-test' });
    assert.deepEqual(value.controller.state.onlineKeys, { asr: false, text: true });
    await value.controller.updateSettings({ online: { ...defaultSettings().online, text: { enabled: true, baseURL: 'https://api.example.com/v1', model: ' remote ' } } });
    await value.controller.importAudio('/synthetic-input.wav');
    assert.deepEqual(requests[1].online, { text: { base_url: 'https://api.example.com/v1', model: 'remote', api_key: 'sk-test' } });
    assert.ok(!JSON.stringify(value.controller.state).includes('sk-test'));
  } finally { await value.close(); }
});
