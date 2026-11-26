import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Controller } from '../controller';
import { LibraryStore } from '../store';
import { AcpmRuntimeInfo, checkOnlineURL, defaultAcpmInfo, defaultSettings, localDayKey, TaskEvent } from '../shared';
import { NativeBridge } from '../processes';
import { InferenceClient, InferenceTaskPayload, OnlineSecrets } from '../inference';

class Native extends EventEmitter {
  calls: string[] = [];
  arguments: { command: string; args: Record<string, unknown> }[] = [];
  async call(command: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.calls.push(command);
    this.arguments.push({ command, args });
    if (['audio.import', 'record.finish'].includes(command)) return { path: '/synthetic.wav', seconds: 2 };
    if (command === 'insert') return { delivery: 'attempted_unverified', name: '写入时的应用' };
    return { accessibility: true, eventTap: true, microphone: 3, devices: [] };
  }
  async start() {}
  stop() {}
}

class MockInference implements InferenceClient {
  mode = 'failure';
  done?: () => void;
  transcribeSegment?: InferenceClient['transcribeSegment'];
  requests: InferenceTaskPayload[] = [];
  prewarms: string[] = [];
  correctionRequests: { original: string; corrected: string; model: string; acpmToken: string }[] = [];
  statusResult: AcpmRuntimeInfo = {
    connected: true,
    source: 'local',
    models: [
      { id: 'qwen3-asr-1.7b', capability: 'asr', displayName: 'Qwen3-ASR 1.7B', installed: true, state: 'WARM' },
      { id: 'yanmo-correct-4b-cot', capability: 'llm', displayName: 'Yanmo 4B', installed: true, state: 'WARM' },
      { id: 'speech-vad-pyannote', capability: 'vad', displayName: 'VAD', installed: true, state: 'WARM' },
    ],
    asrReady: true,
    textReady: true,
    vadReady: true,
  };

  async checkStatus() { return structuredClone(this.statusResult); }
  async prewarm(_settings: any, _secrets: OnlineSecrets, action: string) { this.prewarms.push(action); }
  async extractCorrectionTerms(original: string, corrected: string, settings: any, secrets: OnlineSecrets) {
    const model = settings.online.text.enabled ? settings.online.text.model : settings.acpm.textModel;
    this.correctionRequests.push({ original, corrected, model, acpmToken: secrets.acpmToken });
    return ['沈砚', '沈砚', '已有词'];
  }
  async run(request: InferenceTaskPayload, _audio: unknown, emit: (event: TaskEvent) => void) {
    this.requests.push(request);
    const event = (value: Partial<TaskEvent>) => emit({ task_id: request.task_id, event: 'stage', ...value });
    if (request.operation === 'polish') {
      event({ event: 'result', text: request.context.user_text || request.text, processed: true });
      return;
    }
    event({ event: 'transcript', text: '预算3500元，不是周四。', asr_results: [{ engine_name: 'qwen3-asr-1.7b', transcript: '预算3500元，不是周四。', language: 'Chinese', language_source: 'detected' }] });
    if (this.mode === 'raw') {
      event({ event: 'result', text: '预算3500元，不是周四。', processed: false });
    } else if (this.mode === 'acpm') {
      if (request.archive_audio) event({ event: 'audio', audio_opus: Buffer.from('fLaC\x00\x02acpm-flac').toString('base64') });
      event({ event: 'result', text: '预算3500元，不是周四。', processed: true });
    } else if (this.mode === 'translation') {
      event({ event: 'result', text: 'I want to create a new animation effect.', processed: true });
    } else if (this.mode === 'processingFailure') {
      event({ event: 'error', message: '模拟推理失败' });
    } else if (this.mode === 'cancel') {
      await new Promise<void>(resolve => { this.done = resolve; });
      event({ event: 'result', text: '迟到的结果', processed: true });
    } else {
      event({ event: 'error', message: '模拟整理失败', original: '预算3500元，不是周四。' });
    }
  }
  async cancel() { this.done?.(); }
}

function fixture(textOnlineEnabled = false, acpmTextReady = true) {
  const directory = mkdtempSync(join(tmpdir(), 'yanmo-controller-'));
  const native = new Native();
  const inference = new MockInference();
  inference.statusResult.textReady = acpmTextReady;
  const settings = defaultSettings();
  if (textOnlineEnabled) settings.online.text = { enabled: true, baseURL: 'http://127.0.0.1:9/v1', model: 'fixture' };
  const controller = new Controller(new LibraryStore(directory, settings), native as unknown as NativeBridge, inference);
  controller.state.acpm = structuredClone(inference.statusResult);
  controller.state.runtime.capabilities = { asr: 'acpm', text: textOnlineEnabled ? 'online' : acpmTextReady ? 'acpm' : 'unavailable' };
  controller.state.runtime.status = controller.state.runtime.capabilities.text === 'unavailable' ? 'asr-ready' : 'ready';
  return { controller, native, inference, directory, async close() { await controller.shutdown(); rmSync(directory, { recursive: true, force: true }); } };
}

test('只准备好 AcpmRuntime 语音识别模型时，文字模型不可用也能录音并写入原文', async () => {
  const value = fixture(false, false);
  try {
    value.inference.mode = 'raw';
    await value.controller.checkModels();
    assert.deepEqual(value.controller.state.runtime.capabilities, { asr: 'acpm', text: 'unavailable' });
    await value.controller.perform('dictation', {});
    assert.equal(value.controller.state.stage, 'recording');
    assert.deepEqual(value.inference.prewarms, ['dictation']);
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.deepEqual(value.inference.requests[0].online, {});
    assert.equal(value.inference.requests[0].acpmTextReady, false);
    assert.equal(value.native.arguments.find(call => call.command === 'insert')?.args.text, '预算3500元，不是周四。');
    assert.equal(value.controller.state.library.manuscripts[0].polished, false);
    await value.controller.perform('voiceTranslation', {});
    await value.controller.perform('selectionTranslation', {});
    await value.controller.polishDraft();
    assert.match(value.controller.state.notice, /AcpmRuntime/);
    assert.equal(value.inference.requests.length, 1);
  } finally { await value.close(); }
});

test('AcpmRuntime 未连接时未配置在线 API 不录音并引导至设置；配置在线后正常处理', async () => {
  const value = fixture(false, false);
  value.inference.statusResult = { ...defaultAcpmInfo('local'), connected: false, error: '未检测到运行中的 AcpmRuntime，请先启动 AcpmRuntime。' };
  try {
    await value.controller.checkModels();
    assert.equal(value.controller.state.runtime.status, 'acpm-disconnected');
    assert.match(value.controller.state.notice, /AcpmRuntime/);
    await value.controller.perform('dictation', {});
    assert.equal(value.controller.state.stage, 'idle');
    assert.equal(value.controller.state.page, 'settings');
    assert.ok(!value.native.calls.includes('record.start'));

    const endpoint = { enabled: true, baseURL: 'https://api.example.test/v1', model: 'remote' };
    await value.controller.updateSettings({ online: { asr: endpoint, text: endpoint } });
    assert.equal(value.controller.state.runtime.status, 'ready');
    value.inference.mode = 'translation';
    await value.controller.perform('voiceTranslation', {});
    assert.equal(value.controller.state.stage, 'recording');
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.deepEqual(Object.keys(value.inference.requests[0].online), ['asr', 'text']);
  } finally { await value.close(); }
});

test('输入框上下文不可读仍开始录音，不要求预先提供写入目标', async () => {
  const value = fixture(); value.inference.mode = 'acpm';
  try {
    await value.controller.perform('dictation', {});
    assert.equal(value.controller.state.stage, 'recording');
    assert.ok(value.native.calls.includes('record.start'));
    assert.ok(!value.native.calls.includes('insert'));
    assert.equal(value.inference.requests.length, 0);
    assert.equal(value.controller.state.library.manuscripts.length, 0);
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.native.calls.filter(command => command === 'insert').length, 1);
    assert.equal(value.native.arguments.find(call => call.command === 'insert')?.args.destinationId, undefined);
  } finally { await value.close(); }
});

test('不公开输入控件的应用照常显示录音浮层，无上下文完成识别后只尝试写入一次', async () => {
  const value = fixture(); value.inference.mode = 'acpm';
  try {
    await value.controller.updateSettings({ readContext: true });
    await value.controller.perform('dictation', { id: 'opaque-editor', name: '合成编辑器' });
    assert.equal(value.controller.state.stage, 'recording');
    assert.equal(value.controller.state.overlayVisible, true);
    assert.ok(value.native.calls.includes('record.start'));
    assert.equal(value.inference.requests.length, 0);
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.inference.requests[0].context.before, '');
    assert.equal(value.inference.requests[0].context.after, '');
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
  const value = fixture(); value.inference.mode = 'cancel';
  try {
    value.controller.saveTerm({ term: '迟到的结果', hint: '', aliases: [] });
    await value.controller.perform('dictation', {});
    await new Promise(resolve => setTimeout(resolve, 380));
    const processing = value.controller.finishRecording();
    while (!value.inference.done) await new Promise(resolve => setTimeout(resolve, 1));
    await value.controller.cancel(); await processing;
    assert.equal(value.controller.state.draft, '预算3500元，不是周四。');
    assert.equal(value.controller.state.library.manuscripts.length, 1);
    assert.equal(value.controller.state.library.lexicon[0].matchCount, undefined);
    assert.ok(!value.native.calls.includes('insert')); assert.equal(value.controller.state.stage, 'idle');
  } finally { await value.close(); }
});

test('识别原文和语言随文稿保存，重启后可重新加载', async () => {
  const value = fixture(); value.inference.mode = 'acpm';
  try {
    await value.controller.importAudio('/synthetic-input.wav');
    assert.ok(!value.native.calls.includes('insert'), '导入音频只保留文稿，不自动粘贴到前台应用');
    const item = value.controller.state.library.manuscripts[0];
    assert.equal(item.original, '预算3500元，不是周四。');
    assert.deepEqual(item.asrResults?.map(result => result.engine_name), ['qwen3-asr-1.7b']);
    const store = new LibraryStore(value.directory, defaultSettings());
    assert.equal(store.error, '');
    assert.deepEqual(store.library.manuscripts[0].asrResults, item.asrResults);
    value.controller.state.library = store.library;
    value.controller.select(item.id);
    assert.deepEqual(value.controller.state.asrResults, item.asrResults);
    assert.equal(value.controller.state.asrResults[0].language_source, 'detected');
  } finally { await value.close(); }
});

test('再次整理带入历史识别，用户修改的正文优先且不覆盖原始识别', async () => {
  const value = fixture(); value.inference.mode = 'acpm';
  try {
    await value.controller.importAudio('/synthetic-input.wav');
    const id = value.controller.state.selectedID!;
    await value.controller.polishDraft();
    assert.equal(value.inference.requests.at(-1)!.asr_results.length, 1);
    assert.equal(value.inference.requests.at(-1)!.context.user_text, undefined);
    value.controller.updateDraft(id, '预算4200元，不是周四。');
    await value.controller.polishDraft();
    assert.equal(value.inference.requests.at(-1)!.context.user_text, '预算4200元，不是周四。');
    assert.equal(value.controller.state.draft, '预算4200元，不是周四。');
    assert.equal(value.controller.state.library.manuscripts.length, 1);
    assert.equal(value.controller.state.original, '预算3500元，不是周四。');
  } finally { await value.close(); }
});

test('录音保留输入框上下文快照且受开关约束，后端失败保留诊断', async () => {
  const value = fixture(); value.inference.mode = 'processingFailure';
  try {
    await value.controller.updateSettings({ readContext: true });
    const before = '前'.repeat(350) + '金额3501元'; const after = '后文' + '后'.repeat(350);
    await value.controller.perform('dictation', { id: 'synthetic-target', before, after });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.inference.requests[0].context.before, before.slice(-300));
    assert.equal(value.inference.requests[0].context.after, after.slice(0, 300));
    assert.ok(!value.native.calls.includes('insert'));
    const store = new LibraryStore(value.directory, defaultSettings());
    assert.equal(store.library.manuscripts[0].original, '预算3500元，不是周四。');
    await value.controller.updateSettings({ readContext: false });
    await value.controller.perform('dictation', { id: 'synthetic-target', before, after });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.inference.requests[1].context.before, '');
    assert.equal(value.inference.requests[1].context.after, '');
  } finally { await value.close(); }
});

test('口述译文直接保存并向写入时焦点粘贴一次', async () => {
  const value = fixture(); value.inference.mode = 'translation';
  try {
    await value.controller.perform('voiceTranslation', { id: 'initial-context', name: '起始应用' });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    assert.equal(value.inference.requests[0].operation, 'voiceTranslation');
    assert.equal(value.inference.requests[0].target_language, 'en');
    const calls = value.native.arguments.filter(call => call.command === 'insert');
    assert.deepEqual(calls, [{ command: 'insert', args: { text: 'I want to create a new animation effect.',
      inputEventId: value.inference.requests[0].task_id, characterCount: 40, observationId: undefined } }].map(call => {
      delete (call.args as any).observationId; return call;
    }));
    assert.equal(value.controller.state.stage, 'idle');
    assert.equal(value.controller.state.draft, 'I want to create a new animation effect.');
    assert.equal(value.controller.state.library.manuscripts[0].text, 'I want to create a new animation effect.');
  } finally { await value.close(); }
});

test('Mac 内存录音采用原生时长，不删除路径也不因关闭历史停止识别', async () => {
  const value = fixture();
  value.inference.mode = 'acpm';
  value.controller.state.settings.keepHistory = false;
  value.controller.state.settings.saveRecordingScreenshot = true;
  let captured = false;
  value.controller.captureRecordingScreenshot = async () => { captured = true; return undefined; };
  const wav = Buffer.from('RIFF_SYNTHETIC');
  const call = value.native.call.bind(value.native);
  value.native.call = async (command, args) => command === 'record.finish'
    ? { audioBase64: wav.toString('base64'), seconds: 1.5 }
    : call(command, args);
  const run = value.inference.run.bind(value.inference);
  value.inference.run = async (request, audio, emit) => {
    assert.deepEqual(audio, wav);
    assert.equal(request.archive_audio, false);
    await run(request, audio, emit);
  };
  try {
    await value.controller.perform('dictation', {});
    await value.controller.finishRecording();
    assert.equal(value.controller.state.seconds, 1.5);
    assert.equal(value.controller.state.library.manuscripts.length, 0);
    assert.equal(value.inference.requests.length, 1);
    assert.ok(!captured && !value.native.calls.includes('audio.delete'));
  } finally { await value.close(); }
});

test('划词翻译可读取言墨自身窗口的选区，空选区仍提示先选中', async () => {
  const value = fixture(); value.inference.mode = 'translation';
  try {
    await value.controller.perform('selectionTranslation', {});
    assert.match(value.controller.state.translation.error, /请先选中文字/);
    value.controller.ownSelection = async () => '  Please bring the draft notes  ';
    await value.controller.perform('selectionTranslation', {});
    assert.equal(value.controller.state.translation.source, 'Please bring the draft notes');
    assert.equal(value.inference.requests.at(-1)!.operation, 'selectionTranslation');
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
  const value = fixture(false, true); const requests: InferenceTaskPayload[] = [];
  const run = value.inference.run.bind(value.inference);
  value.inference.run = async (request, audio, emit) => { requests.push(request); return run(request, audio, emit); };
  try {
    await value.controller.importAudio('/synthetic-input.wav');
    assert.deepEqual(requests[0].online, {});
    assert.equal(requests[0].acpmTextReady, true);
    await assert.rejects(value.controller.updateSettings({ online: { ...defaultSettings().online, text: { enabled: true, baseURL: '', model: '' } } }));
    value.controller.setOnlineKeys({ text: 'sk-test' });
    assert.deepEqual(value.controller.state.onlineKeys, { asr: false, text: true });
    await value.controller.updateSettings({ online: { ...defaultSettings().online, text: { enabled: true, baseURL: 'https://api.example.com/v1', model: ' remote ' } } });
    await value.controller.importAudio('/synthetic-input.wav');
    assert.deepEqual(requests[1].online, { text: { base_url: 'https://api.example.com/v1', model: 'remote', api_key: 'sk-test' } });
    assert.equal(requests[1].acpmTextReady, false);
    await value.controller.updateSettings({ polishEnabled: false });
    await value.controller.importAudio('/synthetic-input.wav');
    assert.equal(requests[2].polish, false);
    assert.deepEqual(requests[2].online, {});
    assert.ok(!JSON.stringify(value.controller.state).includes('sk-test'));
  } finally { await value.close(); }
});

test('限时纠词事件通过 AcpmRuntime 或在线文字服务入库、去重并可撤销；不影响已有词', async () => {
  const value = fixture(false, true);
  try {
    value.inference.mode = 'acpm';
    value.controller.setAcpmToken('acpm-tok');
    assert.equal(value.controller.state.acpmTokenSaved, true);
    value.controller.saveTerm({ term: '已有词', hint: '', aliases: [] });
    await value.controller.perform('dictation', { name: 'Claude', category: 'ai_tools' });
    await new Promise(resolve => setTimeout(resolve, 380)); await value.controller.finishRecording();
    const id = value.native.arguments.find(x => x.command === 'insert')!.args.observationId;
    value.native.emit('correction', { observationId: 'stale', original: '联系沈言。', text: '联系沈砚。' });
    assert.equal(value.controller.state.library.lexicon.length, 1);
    value.native.emit('correction', { observationId: id, original: '联系沈言。', text: '联系沈砚。' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(value.inference.correctionRequests, [{ original: '联系沈言。', corrected: '联系沈砚。', model: 'yanmo-correct-4b-cot', acpmToken: 'acpm-tok' }]);
    assert.deepEqual(value.controller.state.learnedTerms, ['沈砚']);
    assert.equal(value.controller.state.library.lexicon.length, 2);
    assert.deepEqual(value.controller.state.library.lexicon[1].aliases, []);
    const disk = new LibraryStore(value.directory, defaultSettings());
    try {
      assert.equal(disk.library.lexicon.length, 2);
      assert.equal(disk.library.lexicon[1].group, 'ai_tools');
    } finally { disk.close(); }
    value.native.emit('correction', { observationId: id, original: '联系沈言。', text: '联系沈砚。' });
    assert.equal(value.inference.correctionRequests.length, 1);
    assert.equal(value.controller.state.library.lexicon.length, 2);
    value.controller.undoLearnedTerms();
    assert.equal(value.controller.state.learnedTerms, undefined);
    assert.deepEqual(value.controller.state.library.lexicon.map(x => x.term), ['已有词']);
  } finally { await value.close(); }
});

test('开始新录音会使旧纠词事件失效', async () => {
  const value = fixture();
  try {
    value.inference.mode = 'acpm';
    await value.controller.perform('dictation', {});
    await new Promise(resolve => setTimeout(resolve, 380)); await value.controller.finishRecording();
    const id = value.native.arguments.find(x => x.command === 'insert')!.args.observationId;
    await value.controller.perform('dictation', {});
    value.native.emit('correction', { observationId: id, original: '联系沈言。', text: '联系沈砚。' });
    assert.equal(value.controller.state.library.lexicon.length, 0);
    assert.equal(value.inference.correctionRequests.length, 0);
    assert.ok(value.native.calls.includes('correction.stop'));
  } finally { await value.close(); }
});

test('控制器发送统一 lexicon 字段并把归档音频随文稿存入数据库', async () => {
  const value = fixture(); value.inference.mode = 'acpm';
  try {
    value.controller.saveTerm({ term: '言墨', hint: '本地语音输入法', aliases: ['研墨'] });
    await value.controller.perform('dictation', { id: 'wx', name: '微信', category: 'messaging' });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();

    const context = value.inference.requests[0].context;
    assert.equal(context.application, '微信');
    assert.deepEqual(value.inference.requests[0].asr_hotwords, ['言墨']);
    assert.deepEqual(context.lexicon, [{ term: '言墨', hint: '本地语音输入法', aliases: ['研墨'] }]);

    const item = value.controller.state.library.manuscripts[0];
    assert.equal(item.hasAudio, true);
    assert.deepEqual(value.controller.store.getAudio(item.id), Buffer.from('fLaC\x00\x02acpm-flac'));

    value.controller.updateDraft(item.id, '用户修改后的正文');
    assert.deepEqual(value.controller.store.getAudio(item.id), Buffer.from('fLaC\x00\x02acpm-flac'));
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
    value.inference.run = async (request, _audio, emit) => {
      value.inference.requests.push(request);
      emit({ event: 'result', task_id: request.task_id, text: '打开 Claude Code，再回到 Claude Code。', processed: true });
    };
    await value.controller.perform('dictation', { name: 'Claude', category: 'ai_tools' });
    await new Promise(resolve => setTimeout(resolve, 380));
    await value.controller.finishRecording();
    const request = value.inference.requests[0];
    assert.equal(request.asr_hotwords!.length, 64);
    assert.equal(request.asr_hotwords!.includes('Claude Code'), false);
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
  value.inference.run = async (request, _audio, emit) => {
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
  const value = fixture(); value.inference.mode = 'acpm';
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
  const value = fixture(); value.inference.mode = 'acpm';
  try {
    await value.controller.updateSettings({ keepHistory: false });
    await value.controller.importAudio('/synthetic.wav');
    assert.equal(value.inference.requests[0].archive_audio, false);
    assert.equal(value.controller.state.library.manuscripts.length, 0);
    assert.match(value.controller.state.draft, /3500/);
    assert.equal(value.controller.store.dailyUsage(localDayKey(new Date())).sent, 0);
  } finally { await value.close(); }
});

for (const mode of ['default', 'enabled', 'unavailable', 'historyOff'] as const) test(`录音结束截屏与文稿联动：${mode}`, async () => {
  const value = fixture(); value.inference.mode = 'acpm';
  const { controller, inference, native } = value;
  const jpeg = Buffer.from('synthetic screenshot');
  let captures = 0;
  controller.captureRecordingScreenshot = async () => {
    captures++;
    assert.ok(native.calls.includes('record.finish'));
    assert.equal(inference.requests.length, 0);
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
    assert.ok(!Object.keys(inference.requests[0]).some(key => key.includes('screenshot')));
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
    value.inference.run = async (request, _audio, emit) => {
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
  value.inference.run = async (request, _audio, emit) => {
    const task_id = request.task_id;
    emit({ event: 'transcript', task_id, text: '合成原文' });
    emit({ event: 'audio', task_id, audio_opus: Buffer.from('fLaC-fixture').toString('base64') });
    started();
    if (outcome === 'cancel') await new Promise<void>(resolve => { value.inference.done = resolve; });
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
  const value = fixture(); value.inference.mode = 'acpm';
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
  const value = fixture(); value.inference.mode = 'acpm';
  const db = new DatabaseSync(value.controller.store.dbPath);
  try {
    await value.controller.importAudio('/synthetic.wav');
    const id = value.controller.state.selectedID!;
    const saved = value.controller.state.draft;
    value.inference.run = async (request, _audio, emit) => emit({ event: 'result', task_id: request.task_id, text: '合成整理结果', processed: true });
    db.exec("CREATE TRIGGER reject_edit BEFORE INSERT ON manuscripts BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    await value.controller.polishDraft();
    assert.equal(value.controller.state.draft, '合成整理结果');
    assert.match(value.controller.state.notice, /未保存/);
    assert.equal(db.prepare('SELECT text FROM manuscripts WHERE id=?').get(id)!.text, saved);
  } finally { db.close(); await value.close(); }
});

test('半流式分段识别：关闭自然整理时每段直接写入，结束不再重复写入；开启自然整理时仅实时预览，结束后整段整理一次写入', async () => {
  const { joinTranscript, joinTranscriptDelta, combineBeforeContext } = await import('../prompts');
  assert.equal(joinTranscript('你好', '世界'), '你好世界');
  assert.equal(joinTranscript('Hello.', 'world'), 'Hello. world');
  assert.equal(joinTranscriptDelta('Hello', 'Yanmo'), ' Yanmo');
  assert.equal(combineBeforeContext('打开', 'Hello world', 300), '打开Hello world');

  // 1. polishEnabled = false: direct insert per segment + tail, no duplicate insert on finish
  const rawCase = fixture();
  rawCase.inference.mode = 'raw';
  await rawCase.controller.updateSettings({ polishEnabled: false });
  const segmentRequests: { prior: string; promptBefore: string }[] = [];
  rawCase.inference.transcribeSegment = async (payload, _audio, prior) => {
    segmentRequests.push({ prior, promptBefore: payload.context.before });
    if (segmentRequests.length === 1) {
      return { text: 'Hello.', engine: 'qwen3-asr-1.7b', language: 'English', languageSource: 'detected' };
    }
    return { text: 'world', engine: 'qwen3-asr-1.7b', language: 'English', languageSource: 'detected' };
  };
  const origNativeCall = rawCase.native.call.bind(rawCase.native);
  const rawInserts: string[] = [];
  rawCase.native.call = async (command, args = {}) => {
    if (command === 'capture') return { name: '备忘录', category: 'document', before: 'Note:' };
    if (command === 'record.finish') {
      return {
        path: '/synthetic.wav',
        seconds: 4,
        emittedSegments: 1,
        tailAudioBase64: Buffer.from('tail-wav').toString('base64'),
      };
    }
    if (command === 'insert') {
      rawInserts.push(String(args.text));
      return { delivery: 'confirmed', name: '备忘录', appKey: 'com.apple.Notes' };
    }
    return origNativeCall(command, args);
  };
  try {
    await rawCase.controller.perform('dictation', { name: '备忘录', category: 'document', before: 'Note:' });
    const startArgs = rawCase.native.arguments.find(c => c.command === 'record.start')?.args;
    assert.equal(startArgs?.streamingVad, true);
    const taskId = String(startArgs?.taskId);
    rawCase.native.emit('audioSegment', {
      taskId,
      index: 0,
      audioBase64: Buffer.from('seg-0').toString('base64'),
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(rawCase.controller.state.liveTranscript, 'Hello.');
    await rawCase.controller.finishRecording();
    assert.deepEqual(rawInserts, ['Hello.', ' world']);
    assert.equal(segmentRequests[0].prior, '');
    assert.equal(segmentRequests[1].prior, 'Hello.');
    assert.equal(rawCase.inference.requests.length, 1);
    assert.equal(rawCase.inference.requests[0].pretranscribed, true);
    assert.equal(rawCase.inference.requests[0].text, 'Hello. world');
  } finally { await rawCase.close(); }

  // 2. polishEnabled = true: preview only while recording, single polished insert on finish
  const polishCase = fixture();
  polishCase.inference.mode = 'acpm';
  let polishSegIndex = 0;
  polishCase.inference.transcribeSegment = async (_payload, _audio, prior) => {
    polishSegIndex += 1;
    if (polishSegIndex === 1) {
      return { text: '第一句', engine: 'qwen3-asr-1.7b', language: 'Chinese', languageSource: 'detected' };
    }
    assert.equal(prior, '第一句');
    return { text: '第二句', engine: 'qwen3-asr-1.7b', language: 'Chinese', languageSource: 'detected' };
  };
  polishCase.inference.run = async (request, _audio, emit) => {
    polishCase.inference.requests.push(request);
    assert.equal(request.pretranscribed, true);
    assert.equal(request.text, '第一句第二句');
    emit({ event: 'transcript', task_id: request.task_id, text: request.text, asr_results: request.asr_results });
    emit({ event: 'result', task_id: request.task_id, text: '第一句，第二句。', processed: true });
  };
  const origPolishCall = polishCase.native.call.bind(polishCase.native);
  const polishInserts: string[] = [];
  polishCase.native.call = async (command, args = {}) => {
    if (command === 'record.finish') {
      return {
        path: '/synthetic.wav',
        seconds: 4,
        emittedSegments: 1,
        tailAudioBase64: Buffer.from('tail-wav').toString('base64'),
      };
    }
    if (command === 'insert') {
      polishInserts.push(String(args.text));
      return { delivery: 'confirmed', name: '文本编辑', appKey: 'com.apple.TextEdit' };
    }
    return origPolishCall(command, args);
  };
  try {
    await polishCase.controller.perform('dictation', {});
    const taskId = String(polishCase.native.arguments.find(c => c.command === 'record.start')?.args.taskId);
    polishCase.native.emit('audioSegment', {
      taskId,
      index: 0,
      audioBase64: Buffer.from('seg-0').toString('base64'),
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(polishCase.controller.state.liveTranscript, '第一句');
    assert.equal(polishInserts.length, 0);
    await polishCase.controller.finishRecording();
    assert.deepEqual(polishInserts, ['第一句，第二句。']);
    assert.equal(polishCase.controller.state.liveTranscript, '');
  } finally { await polishCase.close(); }
});
