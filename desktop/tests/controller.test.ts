import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Controller } from '../controller';
import { LibraryStore } from '../store';
import { checkOnlineURL, defaultSettings, localDayKey, TaskEvent } from '../shared';
import { NativeBridge, BackendClient } from '../processes';

class Native extends EventEmitter {
  calls: string[] = [];
  arguments: { command: string; args: Record<string, unknown> }[] = [];
  async call(command: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> { this.calls.push(command); this.arguments.push({ command, args }); if (['audio.import', 'record.finish'].includes(command)) return { path: '/synthetic.wav', seconds: 2 }; if (command === 'insert') return { delivery: 'attempted_unverified', name: '写入时的应用' }; return { accessibility: true, eventTap: true, microphone: 3, devices: [] }; }
  async start() {} stop() {}
}
class Backend {
  mode = 'failure'; done?: () => void;
  requests: any[] = [];
  correctionRequests: { original: string; corrected: string; model: string }[] = [];
  async extractCorrectionTerms(original: string, corrected: string, online: { model: string }) {
    this.correctionRequests.push({ original, corrected, model: online.model });
    return ['沈砚', '沈砚', '已有词'];
  }
  setActive(_value: boolean) {} async stop() {} async status() { return { metal: true, models: { asr: { ready: true }, sensevoice: { ready: true } } }; } async warmup() {}
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
      if (request.archive_audio) event({ event: 'audio', audio_opus: Buffer.from('OggS\x00\x02dual-opus').toString('base64') });
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
function fixture(textEnabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'yanmo-controller-')); const native = new Native(); const backend = new Backend();
  const settings = defaultSettings();
  if (textEnabled) settings.online.text = { enabled: true, baseURL: 'http://127.0.0.1:9/v1', model: 'fixture' };
  const controller = new Controller(new LibraryStore(directory, settings), native as unknown as NativeBridge, backend as unknown as BackendClient);
  controller.environment = { environment: 'ready', issues: [] };
  controller.state.models = { asr: true, sensevoice: true, metal: true };
  controller.state.runtime.capabilities.asr = 'local';
  return { controller, native, backend, directory, async close() { await controller.shutdown(); rmSync(directory, { recursive: true, force: true }); } };
}
test('文字 API 未启用时，在本机语音模型已就绪的情况下也不会开始录音', async () => {
  const value = fixture(false);
  try {
    await value.controller.perform('dictation', {});
    assert.equal(value.controller.state.page, 'settings');
    assert.match(value.controller.state.notice, /文字处理 API/);
    assert.ok(!value.native.calls.includes('record.start'));
    assert.equal(value.backend.requests.length, 0);
  } finally { await value.close(); }
});
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
    value.controller.saveTerm({ term: '预算', hint: '', aliases: [] });
    await value.controller.perform('dictation', {});
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.controller.state.library.manuscripts.length, 1);
    assert.equal(value.controller.state.draft, '预算3500元，不是周四。');
    assert.equal(value.controller.state.library.lexicon[0].matchCount, undefined);
    assert.equal(value.controller.state.stage, 'failure'); assert.ok(!value.native.calls.includes('insert'));
    assert.ok(value.native.calls.includes('audio.delete'));
  } finally { await value.close(); }
});
test('取消后丢弃迟到的完成结果，原文只保存一次', async () => {
  const value = fixture(); value.backend.mode = 'cancel';
  try {
    value.controller.saveTerm({ term: '迟到的结果', hint: '', aliases: [] });
    await value.controller.perform('dictation', {});
    await new Promise(resolve => setTimeout(resolve, 380));
    const processing = value.controller.finishRecording();
    while (!value.backend.done) await new Promise(resolve => setTimeout(resolve, 1));
    await value.controller.cancel(); await processing;
    assert.equal(value.controller.state.draft, '预算3500元，不是周四。');
    assert.equal(value.controller.state.library.manuscripts.length, 1);
    assert.equal(value.controller.state.library.lexicon[0].matchCount, undefined);
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
    const store = new LibraryStore(value.directory, defaultSettings());
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
    const store = new LibraryStore(value.directory, defaultSettings());
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
    assert.deepEqual(calls, [{ command: 'insert', args: { text: 'I want to create a new animation effect.',
      inputEventId: value.backend.requests[0].task_id, characterCount: 40 } }]);
    assert.equal(value.controller.state.stage, 'idle');
    assert.equal(value.controller.state.draft, 'I want to create a new animation effect.');
    assert.equal(value.controller.state.library.manuscripts[0].text, 'I want to create a new animation effect.');
  } finally { await value.close(); }
});
test('Mac 内存录音采用原生时长，不删除路径也不因关闭历史停止识别', async () => {
  const value = fixture();
  value.backend.mode = 'dual';
  value.controller.state.settings.keepHistory = false;
  value.controller.state.settings.saveRecordingScreenshot = true;
  let captured = false;
  value.controller.captureRecordingScreenshot = async () => { captured = true; return undefined; };
  const wav = Buffer.from('RIFF_SYNTHETIC');
  const call = value.native.call.bind(value.native);
  value.native.call = async (command, args) => command === 'record.finish'
    ? { audioBase64: wav.toString('base64'), seconds: 1.5 }
    : call(command, args);
  const run = value.backend.run.bind(value.backend);
  value.backend.run = async (request, audio, emit) => {
    assert.deepEqual(audio, wav);
    assert.equal(request.archive_audio, false);
    await run(request, audio, emit);
  };
  try {
    await value.controller.perform('dictation', {});
    await value.controller.finishRecording();
    assert.equal(value.controller.state.seconds, 1.5);
    assert.equal(value.controller.state.library.manuscripts.length, 0);
    assert.equal(value.backend.requests.length, 1);
    assert.ok(!captured && !value.native.calls.includes('audio.delete'));
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
  const value = fixture(false); const requests: any[] = [];
  const run = value.backend.run.bind(value.backend);
  value.backend.run = async (request: any, audio: unknown, emit: any) => { requests.push(request); return run(request, audio, emit); };
  try {
    await value.controller.importAudio('/synthetic-input.wav');
    assert.equal(requests.length, 0);
    await assert.rejects(value.controller.updateSettings({ online: { ...defaultSettings().online, text: { enabled: true, baseURL: '', model: '' } } }));
    value.controller.setOnlineKeys({ text: 'sk-test' });
    assert.deepEqual(value.controller.state.onlineKeys, { asr: false, text: true });
    await value.controller.updateSettings({ online: { ...defaultSettings().online, text: { enabled: true, baseURL: 'https://api.example.com/v1', model: ' remote ' } } });
    await value.controller.importAudio('/synthetic-input.wav');
    assert.deepEqual(requests[0].online, { text: { base_url: 'https://api.example.com/v1', model: 'remote', api_key: 'sk-test' } });
    assert.ok(!('llm_model' in requests[0].models));
    assert.ok(!JSON.stringify(value.controller.state).includes('sk-test'));
  } finally { await value.close(); }
});
test('Windows 无 CUDA：未配置在线前不录音也不启动后端，配置后按在线处理', async () => {
  const value = fixture(false); value.backend.mode = 'translation';
  let statusCalls = 0; const status = value.backend.status.bind(value.backend);
  value.backend.status = async () => { statusCalls++; return status(); };
  value.controller.windowsPrecheck = async () => ({ environment: 'unsupported', issues: ['未检测到 NVIDIA GPU 或驱动。'] });
  try {
    await value.controller.checkModels();
    assert.equal(statusCalls, 0);
    assert.equal(value.controller.state.runtime.status, 'recommend-online');
    assert.match(value.controller.state.notice, /配置前不会上传/);
    await value.controller.perform('dictation', {});
    assert.equal(value.controller.state.stage, 'idle'); assert.equal(value.controller.state.page, 'settings');
    assert.ok(!value.native.calls.includes('record.start'));
    assert.match(value.controller.state.notice, /文字处理 API/);
    const endpoint = { enabled: true, baseURL: 'https://api.example.test/v1', model: 'remote' };
    await value.controller.updateSettings({ online: { asr: endpoint, text: endpoint } });
    assert.equal(value.controller.state.runtime.status, 'online-ready');
    await value.controller.perform('voiceTranslation', {});
    assert.equal(value.controller.state.stage, 'recording');
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.deepEqual(Object.keys(value.backend.requests[0].online), ['asr', 'text']);
  } finally { await value.close(); }
});

test('限时纠词事件入库、去重并可撤销；不影响已有词', async () => {
  const value = fixture();
  try {
    value.backend.mode = 'dual';
    value.controller.saveTerm({ term: '已有词', hint: '', aliases: [] });
    await value.controller.perform('dictation', { name: 'Claude', category: 'ai_tools' });
    await new Promise(resolve => setTimeout(resolve, 380)); await value.controller.finishRecording();
    const id = value.native.arguments.find(x => x.command === 'insert')!.args.observationId;
    value.native.emit('correction', { observationId: 'stale', original: '联系沈言。', text: '联系沈砚。' });
    assert.equal(value.controller.state.library.lexicon.length, 1);
    value.native.emit('correction', { observationId: id, original: '联系沈言。', text: '联系沈砚。' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(value.backend.correctionRequests, [{ original: '联系沈言。', corrected: '联系沈砚。', model: 'fixture' }]);
    assert.deepEqual(value.controller.state.learnedTerms, ['沈砚']);
    assert.equal(value.controller.state.library.lexicon.length, 2);
    assert.deepEqual(value.controller.state.library.lexicon[1].aliases, []);
    const disk = new LibraryStore(value.directory, defaultSettings());
    try {
      assert.equal(disk.library.lexicon.length, 2);
      assert.equal(disk.library.lexicon[1].group, 'ai_tools');
    } finally { disk.close(); }
    value.native.emit('correction', { observationId: id, original: '联系沈言。', text: '联系沈砚。' });
    assert.equal(value.backend.correctionRequests.length, 1);
    assert.equal(value.controller.state.library.lexicon.length, 2);
    value.controller.undoLearnedTerms();
    assert.equal(value.controller.state.learnedTerms, undefined);
    assert.deepEqual(value.controller.state.library.lexicon.map(x => x.term), ['已有词']);
  } finally { await value.close(); }
});
test('开始新录音会使旧纠词事件失效', async () => {
  const value = fixture();
  try {
    value.backend.mode = 'dual';
    await value.controller.perform('dictation', {});
    await new Promise(resolve => setTimeout(resolve, 380)); await value.controller.finishRecording();
    const id = value.native.arguments.find(x => x.command === 'insert')!.args.observationId;
    await value.controller.perform('dictation', {});
    value.native.emit('correction', { observationId: id, original: '联系沈言。', text: '联系沈砚。' });
    assert.equal(value.controller.state.library.lexicon.length, 0);
    assert.equal(value.backend.correctionRequests.length, 0);
    assert.ok(value.native.calls.includes('correction.stop'));
  } finally { await value.close(); }
});
test('控制器发送统一 lexicon 字段并把 Opus 音频随文稿存入数据库', async () => {
  const value = fixture(); value.backend.mode = 'dual';
  try {
    value.controller.saveTerm({ term: '言墨', hint: '本地语音输入法', aliases: ['研墨'] });
    await value.controller.perform('dictation', { id: 'wx', name: '微信', category: 'messaging' });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();

    const context = value.backend.requests[0].context;
    assert.equal(context.application, '微信');
    assert.deepEqual(value.backend.requests[0].asr_hotwords, ['言墨']);
    assert.deepEqual(context.lexicon, [{ term: '言墨', hint: '本地语音输入法', aliases: ['研墨'] }]);
    assert.equal('key_terms' in context, false);
    assert.equal('term_notes' in context, false);

    const item = value.controller.state.library.manuscripts[0];
    assert.equal(item.hasAudio, true);
    assert.deepEqual(value.controller.store.getAudio(item.id), Buffer.from('OggS\x00\x02dual-opus'));

    // Updating draft and deleting manuscript keeps/cleans audio consistently.
    value.controller.updateDraft(item.id, '用户修改后的正文');
    assert.deepEqual(value.controller.store.getAudio(item.id), Buffer.from('OggS\x00\x02dual-opus'));
    value.controller.deleteManuscript(item.id);
    assert.equal(value.controller.store.getAudio(item.id), undefined);
  } finally { await value.close(); }
});

test('实际任务只发本组与全局热词，成功口述给未入选的规范词计一次，关闭历史仍保存词频', async () => {
  const value = fixture();
  try {
    await value.controller.updateSettings({ keepHistory: false });
    const dictionary = value.controller.state.library.lexicon;
    dictionary.push(...Array.from({ length: 48 }, (_, index) => ({
      id: `ranked${index}`, term: `工具${index}`, hint: '', group: 'ai_tools' as const, matchCount: 10,
    })));
    dictionary.push(
      { id: 'scoped', term: 'Claude Code', hint: '工具说明', aliases: ['克劳德'], group: 'ai_tools' },
      { id: 'global-duplicate', term: 'Claude Code', hint: '全局说明' },
      { id: 'hidden', term: 'Claude Code', hint: '', group: 'document' },
      ...Array.from({ length: 16 }, (_, index) => ({ id: `global${index}`, term: `全局${index}`, hint: '' })),
    );
    value.controller.store.persist();
    value.backend.run = async (request, _audio, emit) => {
      value.backend.requests.push(request);
      emit({ event: 'result', task_id: request.task_id, text: '打开 Claude Code，再回到 Claude Code。', processed: true });
    };
    await value.controller.perform('dictation', { name: 'Claude', category: 'ai_tools' });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    const request = value.backend.requests[0];
    assert.equal(request.asr_hotwords.length, 64);
    assert.equal(request.asr_hotwords.includes('Claude Code'), false);
    assert.deepEqual(request.context.lexicon.filter((item: { term: string }) => item.term === 'Claude Code'), [
      { term: 'Claude Code', hint: '工具说明', aliases: ['克劳德'] },
    ]);
    const disk = new LibraryStore(value.directory, defaultSettings());
    try {
      assert.equal(disk.library.manuscripts.length, 0);
      assert.equal(disk.library.lexicon.find(x => x.id === 'scoped')?.matchCount, 1);
      assert.ok(disk.library.lexicon.find(x => x.id === 'scoped')?.lastMatchedAt);
      for (const id of ['global-duplicate', 'hidden']) assert.equal(disk.library.lexicon.find(x => x.id === id)?.matchCount, undefined);
    } finally { disk.close(); }

    await value.controller.perform('voiceTranslation', { name: 'Claude', category: 'ai_tools' });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.controller.state.library.lexicon.find(x => x.id === 'scoped')?.matchCount, 1);
  } finally { await value.close(); }
});


test('音频编码失败仍交付正文，并在文稿中持久保留警告', async () => {
  const value = fixture();
  value.backend.run = async (request, _audio, emit) => {
    assert.equal(request.archive_audio, true);
    const task_id = request.task_id;
    emit({ event: 'transcript', task_id, text: '合成原文' });
    emit({ event: 'audio', task_id, audio_warning: '录音未保存：音频压缩失败，文字处理继续。' });
    emit({ event: 'result', task_id, text: '合成正文', processed: true });
  };
  try {
    await value.controller.importAudio('/synthetic.wav');
    const item = value.controller.state.library.manuscripts[0];
    assert.equal(item.text, '合成正文'); assert.equal(item.hasAudio, undefined);
    assert.match(item.audioWarning!, /录音未保存/);
    value.controller.store.close();
    const reopened = new LibraryStore(value.directory, defaultSettings());
    try { assert.equal(reopened.library.manuscripts[0].audioWarning, item.audioWarning); } finally { reopened.close(); }
  } finally { await value.close(); }
});

test('数据库拒绝音频文稿时保留可复制正文，不显示已保存历史', async () => {
  const value = fixture(); value.backend.mode = 'dual';
  const db = new DatabaseSync(value.controller.store.dbPath);
  db.exec("CREATE TRIGGER reject_audio BEFORE INSERT ON manuscripts WHEN new.audio_opus IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
  try {
    value.controller.saveTerm({ term: '预算', hint: '', aliases: [] });
    await value.controller.perform('dictation', {});
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.match(value.controller.state.draft, /3500/);
    assert.equal(value.controller.state.selectedID, null);
    assert.equal(value.controller.state.library.manuscripts.length, 0);
    assert.match(value.controller.state.notice, /未保存/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM manuscripts').get()!.n, 0);
    assert.equal(db.prepare('SELECT match_count FROM lexicon').get()?.match_count, 0);
    assert.equal(value.controller.state.library.lexicon[0].matchCount, undefined);
  } finally { db.close(); await value.close(); }
});

test('关闭历史保存时请求不归档音频，正文仍正常返回', async () => {
  const value = fixture(); value.backend.mode = 'dual';
  try {
    await value.controller.updateSettings({ keepHistory: false });
    await value.controller.importAudio('/synthetic.wav');
    assert.equal(value.backend.requests[0].archive_audio, false);
    assert.equal(value.controller.state.library.manuscripts.length, 0);
    assert.match(value.controller.state.draft, /3500/);
    assert.equal(value.controller.store.dailyUsage(localDayKey(new Date())).sent, 0);
  } finally { await value.close(); }
});

for (const mode of ['default', 'enabled', 'unavailable', 'historyOff'] as const) test(`录音结束截屏与文稿联动：${mode}`, async () => {
  const value = fixture(); value.backend.mode = 'dual';
  const { controller, backend, native } = value;
  const jpeg = Buffer.from('synthetic screenshot');
  let captures = 0;
  controller.captureRecordingScreenshot = async () => {
    captures++;
    assert.ok(native.calls.includes('record.finish'));
    assert.equal(backend.requests.length, 0);
    if (mode === 'unavailable') throw new Error('模拟权限失败');
    return jpeg;
  };
  try {
    if (mode !== 'default') await controller.updateSettings({ saveRecordingScreenshot: true, keepHistory: mode !== 'historyOff' });
    await controller.perform(mode === 'unavailable' ? 'voiceTranslation' : 'dictation', {});
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal(captures, 0);
    const ended = Date.now();
    await controller.finishRecording();
    assert.equal(captures, mode === 'enabled' || mode === 'unavailable' ? 1 : 0);
    assert.match(controller.state.draft, /3500/);
    assert.equal(native.calls.filter(call => call === 'insert').length, 1);
    assert.ok(!Object.keys(backend.requests[0]).some(key => key.includes('screenshot')));
    const db = new DatabaseSync(controller.store.dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT occurred_at, recording_ended_at_ms, screenshot_image FROM manuscripts').get();
      if (mode === 'historyOff') assert.equal(row, undefined);
      else {
        assert.ok(Number(row!.recording_ended_at_ms) >= ended);
        assert.ok(Date.parse(String(row!.occurred_at)) >= Number(row!.recording_ended_at_ms));
        if (mode === 'enabled') assert.deepEqual(Buffer.from(row!.screenshot_image as Uint8Array), jpeg);
        else assert.equal(row!.screenshot_image, null);
      }
      if (mode === 'unavailable') assert.match(controller.state.notice, /未能保存截屏/);
    } finally { db.close(); }
  } finally { await value.close(); }
});

test('粘贴发出后取消仍记给实际目标，关闭文稿保存也计入组合字符', async () => {
  const value = fixture();
  try {
    await value.controller.updateSettings({ keepHistory: false });
    value.backend.run = async (request, _audio, emit) => {
      emit({ task_id: request.task_id, event: 'result', text: '甲👨‍👩‍👧‍👦e\u0301', processed: true });
    };
    const call = value.native.call.bind(value.native);
    value.native.call = async (command, args = {}) => {
      if (command !== 'insert') return call(command, args);
      value.native.emit('inputDispatched', {
        eventId: args.inputEventId, occurredAtMs: Date.now(), appKey: 'com.apple.TextEdit', appName: '文本编辑',
        characters: args.characterCount, confirmed: false,
      });
      value.native.emit('cancel');
      throw new Error('粘贴后的等待被取消');
    };
    await value.controller.perform('dictation', { name: '开始录音时的应用' });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    const stats = value.controller.store.dailyUsage(localDayKey(new Date()));
    assert.deepEqual(stats.apps, [{ appKey: 'com.apple.TextEdit', name: '文本编辑', sent: 3, confirmed: 0, unverified: 3 }]);
    assert.equal(value.controller.state.library.manuscripts.length, 0);
  } finally { await value.close(); }
});


for (const outcome of ['failure', 'cancel'] as const) test(`音频文稿保存失败时${outcome}不覆盖未保存提示`, async () => {
  const value = fixture();
  const db = new DatabaseSync(value.controller.store.dbPath);
  db.exec("CREATE TRIGGER reject_audio BEFORE INSERT ON manuscripts WHEN new.audio_opus IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  value.backend.run = async (request, _audio, emit) => {
    const task_id = request.task_id;
    emit({ event: 'transcript', task_id, text: '合成原文' });
    emit({ event: 'audio', task_id, audio_opus: Buffer.from('OggS-fixture').toString('base64') });
    started();
    if (outcome === 'cancel') await new Promise<void>(resolve => { value.backend.done = resolve; });
    else emit({ event: 'error', task_id, message: '模拟整理失败' });
  };
  try {
    const processing = value.controller.importAudio('/synthetic.wav');
    await entered;
    if (outcome === 'cancel') await value.controller.cancel();
    await processing;
    assert.match(value.controller.state.notice, /未保存/);
    assert.equal(value.controller.state.selectedID, null);
    assert.equal(value.controller.state.draft, '合成原文');
    assert.equal(db.prepare('SELECT count(*) AS n FROM manuscripts').get()!.n, 0);
  } finally { db.close(); await value.close(); }
});

test('跨应用写入失败后再次保存识别原文仍保留失败说明和音频', async () => {
  const value = fixture(); value.backend.mode = 'dual';
  const call = value.native.call.bind(value.native);
  value.native.call = async (command, args = {}) => {
    if (command === 'insert') throw new Error('模拟写入失败');
    return call(command, args);
  };
  try {
    await value.controller.perform('dictation', {});
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    const item = value.controller.state.library.manuscripts[0];
    assert.match(item.deliveryNote!, /模拟写入失败/);
    assert.equal(item.hasAudio, true);
    assert.ok(value.controller.store.getAudio(item.id)?.length);
  } finally { await value.close(); }
});

test('手动整理已有文稿保存失败时保留结果和未保存提示', async () => {
  const value = fixture(); value.backend.mode = 'dual';
  const db = new DatabaseSync(value.controller.store.dbPath);
  try {
    await value.controller.importAudio('/synthetic.wav');
    const id = value.controller.state.selectedID!;
    const saved = value.controller.state.draft;
    value.backend.run = async (request, _audio, emit) => emit({ event: 'result', task_id: request.task_id, text: '合成整理结果', processed: true });
    db.exec("CREATE TRIGGER reject_edit BEFORE INSERT ON manuscripts BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    await value.controller.polishDraft();
    assert.equal(value.controller.state.draft, '合成整理结果');
    assert.match(value.controller.state.notice, /未保存/);
    assert.equal(db.prepare('SELECT text FROM manuscripts WHERE id=?').get(id)!.text, saved);
  } finally { db.close(); await value.close(); }
});
