import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ACTIONS, Action, AppState, ASRResult, Capability, busy, characterCount, cocoaNow, defaultAcpmInfo, defaultSettings, Destination, isTermGroup, Language, LANGUAGES, Manuscript, NativeStatus, Page, Settings, Shortcut, shortcutID, TaskEvent, Term, TermGroup, validateSettings } from './shared';
import { maxAudioBytes, NativeBridge, TaskAudio } from './processes';
import { InferenceClient, InferenceTaskPayload, OnlineSecrets } from './inference';
import { AppInputEvent, LibraryStore, ManuscriptMedia } from './store';
import { decideRuntime } from './precheck';
import { matchedTermIDs, scopedTerms, selectASRHotwords, termGroup, termKey } from './hotwords';
import { joinTranscript, joinTranscriptDelta } from './prompts';

interface FinishedRecording { path?: string; audioBase64?: string; seconds?: number; emittedSegments?: number; tailAudioBase64?: string }

interface Task {
  id: string; action: Action; settings: Settings; destination: Destination; lexicon: Term[];
  started: number; manuscriptID: string; original: string; asrResults: ASRResult[]; audio?: TaskAudio; abort: AbortController;
  audioOpus?: Buffer; audioWarning?: string; userText?: string; manual?: boolean; writeToFocus?: boolean;
  recordingEndedAtMs?: number; screenshotImage?: Buffer;
  segmentChain?: Promise<void>;
  emittedSegments?: number;
  committedStreamText?: string;
  streamDestinationName?: string;
  streamAppKey?: string;
  streamConfirmed?: boolean;
  streamEngine?: string;
  streamLanguage?: string | null;
  streamLanguageSource?: ASRResult['language_source'];
  streamError?: string;
  pretranscribed?: boolean;
}

export class Controller extends EventEmitter {
  readonly state: AppState;
  private task?: Task;
  private observation?: { id: string; group: TermGroup };
  private shuttingDown = false;
  private learned: Term[] = [];
  private learningDismiss?: NodeJS.Timeout;
  private userEdited = false;
  private clock?: NodeJS.Timeout;
  private dismiss?: NodeJS.Timeout;
  private cancelling?: Promise<unknown>;
  private settingsQueue: Promise<unknown> = Promise.resolve();
  private remoteRevision = 0;
  /** Selected text in 言墨's focused main window, if any. */
  ownSelection?: () => Promise<string>;
  /** A single local screenshot, requested only when ending an opted-in recording. */
  captureRecordingScreenshot?: () => Promise<Buffer | undefined>;
  constructor(readonly store: LibraryStore, readonly native: NativeBridge, readonly inference: InferenceClient) {
    super();
    this.state = {
      page: 'desk', stage: 'idle', action: 'dictation', settings: store.settings, library: store.library,
      selectedID: null, draft: '', original: '', liveTranscript: '', asrResults: [], notice: store.error, seconds: 0, level: 0,
      destinationName: '言墨文稿', checking: false, modelsChecked: false, overlayVisible: false,
      acpm: defaultAcpmInfo(store.settings.acpm.mode), acpmTokenSaved: false,
      native: { accessibility: false, eventTap: false, microphone: 0, devices: [] },
      translation: { source: '', result: '', language: store.settings.selectionTarget, loading: false, error: '' },
      captureAction: null, shortcutNotice: '', launchAtLogin: false, onlineKeys: { asr: false, text: false },
      runtime: decideRuntime(store.settings.online), platform: 'mac',
    };
    this.remoteRevision = store.remoteRevision;
    native.on('shortcut', ({ action, destination }: { action: Action; destination: Destination }) => {
      if (action in ACTIONS) void this.perform(action, destination);
    });
    native.on('correction', value => void this.learnCorrections(value));
    native.on('inputDispatched', (event: AppInputEvent) => this.recordAppInput(event));
    native.on('cancel', () => void this.cancel());
    native.on('permissions', () => void this.permissions());
    native.on('meter', ({ taskId, level }: { taskId: string; level: number }) => {
      if (this.task?.id === taskId && this.state.stage === 'recording') { this.state.level = Math.min(1, Math.max(0, Number(level) || 0)); this.emit('meter', { level: this.state.level, seconds: this.state.seconds }); }
    });
    native.on('audioSegment', ({ taskId, audioBase64 }: { taskId: string; audioBase64?: string }) => {
      const task = this.task;
      if (!task || task.id !== taskId || this.state.stage !== 'recording' || !this.inference.transcribeSegment || !audioBase64) return;
      task.emittedSegments = (task.emittedSegments ?? 0) + 1;
      const wav = Buffer.from(audioBase64, 'base64');
      task.segmentChain = (task.segmentChain ?? Promise.resolve()).then(() => this.handleAudioSegment(task, wav));
    });
    native.on('shortcutCaptured', ({ shortcut }: { shortcut?: Shortcut }) => {
      if (!shortcut) void this.endCapture();
      else void this.saveCaptured(shortcut);
    });
    native.on('fault', () => { if (busy(this.state.stage)) void this.cancel(); this.notice('系统桥接已退出，请重新检查权限或重启言墨。'); });
  }
  private keys: Partial<Record<Capability, string>> = {};
  private acpmToken = '';
  /** Decrypted by the main process; the renderer only learns whether a key exists. */
  setOnlineKeys(keys: Partial<Record<Capability, string>>) { this.keys = keys; this.state.onlineKeys = { asr: !!keys.asr, text: !!keys.text }; this.changed(); }
  setAcpmToken(token: string) { this.acpmToken = token; this.state.acpmTokenSaved = !!token; this.changed(); }
  private secrets(): OnlineSecrets { return { online: this.keys, acpmToken: this.acpmToken }; }
  changed() {
    if (!busy(this.state.stage) && this.learned.length && !this.state.learnedTerms) {
      this.state.learnedTerms = this.learned.map(item => item.term);
      this.learningDismiss = setTimeout(() => { this.clearLearningNotice(); this.changed(); }, 6000);
    }
    this.emit('state', this.state);
  }
  private refreshRuntime() {
    this.state.runtime = decideRuntime(this.state.settings.online, this.state.acpm);
  }
  notice(message: string) { this.state.notice = message; this.changed(); }
  private persist(media?: ManuscriptMedia) {
    if (this.store.remoteRevision !== this.remoteRevision) {
      this.reloadLibraryFromStore();
      this.state.notice = '文稿或词库已在后台同步更新，请重试刚才的操作。';
      this.changed();
      return false;
    }
    this.store.library = this.state.library; this.store.settings = this.state.settings;
    try { this.store.persist(media); this.remoteRevision = this.store.remoteRevision; return true; } catch { this.state.notice = '文稿或设置未保存，请检查存储空间后重试；当前正文仍可复制。'; return false; }
  }
  private bindings(settings = this.state.settings) {
    return (Object.keys(ACTIONS) as Action[]).flatMap(action => settings.shortcuts[action].map(shortcut => ({ action, shortcut })));
  }
  async initialize() {
    await this.native.start();
    try { this.state.native = await this.native.call('configure', { bindings: this.bindings(), readContext: this.state.settings.readContext }); }
    catch (error) { this.state.notice = (error as Error).message; this.state.native = await this.native.call('status'); }
    this.store.prune(); this.state.library = this.store.library; this.persist(); this.changed();
    await this.checkModels();
  }
  async permissions(request = false, guide: { app?: string; source?: Record<string, number> } = {}) {
    this.state.native = await this.native.call('permissions', { request, ...guide });
    try { this.state.native = await this.native.call('configure', { bindings: this.bindings(), readContext: this.state.settings.readContext }); }
    catch (error) { this.state.native.eventTap = false; this.state.notice = (error as Error).message; }
    this.changed();
  }
  async checkModels() {
    if (this.shuttingDown || busy(this.state.stage) || this.state.checking || this.state.captureAction) return;
    const settings = structuredClone(this.state.settings);
    const outdated = () => JSON.stringify(settings.acpm) !== JSON.stringify(this.state.settings.acpm);
    this.state.checking = true; this.changed();
    try {
      await this.cancelling;
      const [acpm, native] = await Promise.all([
        this.inference.checkStatus(settings, this.secrets()),
        this.native.call<NativeStatus>('status'),
      ]);
      if (outdated()) return;
      this.state.acpm = acpm;
      this.state.native = native;
      this.refreshRuntime();
      if (!acpm.connected && !this.state.settings.online.asr.enabled) {
        this.state.notice = acpm.error || '未检测到运行中的 AcpmRuntime，请先启动 AcpmRuntime。';
      } else if (acpm.connected && /未检测到运行中的 AcpmRuntime|无法连接到 AcpmRuntime|AcpmRuntime 服务未在运行|AcpmRuntime 发现文件|AcpmRuntime 鉴权失败/.test(this.state.notice)) {
        this.state.notice = '';
      }
    } catch (error) { this.state.notice = (error as Error).message; }
    finally {
      this.state.checking = false;
      if (outdated()) await this.checkModels();
      else { this.state.modelsChecked = true; this.changed(); }
    }
  }
  updateSettings(patch: Partial<Settings>) {
    const next = this.settingsQueue.then(() => this.applySettings(patch));
    this.settingsQueue = next.catch(() => {});
    return next;
  }
  private async applySettings(patch: Partial<Settings>) {
    if (busy(this.state.stage)) throw new Error('请先结束当前任务，再修改设置。');
    const allowed = Object.keys(defaultSettings());
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('设置项目无效。');
    const proposed = { ...this.state.settings, ...patch };
    validateSettings(proposed);
    let native = this.state.native;
    if (JSON.stringify(proposed.shortcuts) !== JSON.stringify(this.state.settings.shortcuts) || proposed.readContext !== this.state.settings.readContext) {
      native = await this.native.call<NativeStatus>('configure', { bindings: this.bindings(proposed), readContext: proposed.readContext });
    }
    const acpmChanged = JSON.stringify(proposed.acpm) !== JSON.stringify(this.state.settings.acpm);
    this.state.settings = proposed; this.state.native = native;
    this.store.settings = proposed; this.store.library = this.state.library; this.store.prune(); this.state.library = this.store.library;
    if (this.state.selectedID && !this.state.library.manuscripts.some(item => item.id === this.state.selectedID)) { this.state.selectedID = null; this.state.draft = ''; this.state.original = ''; this.state.asrResults = []; this.userEdited = false; }
    if (acpmChanged) this.state.acpm = defaultAcpmInfo(proposed.acpm.mode);
    this.refreshRuntime();
    this.persist(); this.changed(); this.emit('preferences', proposed);
    if (acpmChanged && !this.state.checking) await this.checkModels();
  }
  async beginCapture(action: Action) {
    if (busy(this.state.stage) || this.state.checking || !(action in ACTIONS)) return;
    this.state.captureAction = action; this.state.shortcutNotice = '';
    await this.native.call('captureShortcut', { enabled: true }); this.changed();
  }
  async endCapture() {
    await this.native.call('captureShortcut', { enabled: false }); this.state.captureAction = null; this.changed();
  }
  async saveCaptured(shortcut: Shortcut) {
    const action = this.state.captureAction; if (!action) return;
    try {
      const shortcuts = structuredClone(this.state.settings.shortcuts);
      shortcuts[action].push(shortcut);
      await this.updateSettings({ shortcuts });
      this.state.captureAction = null; this.state.shortcutNotice = '快捷键已保存。轻按开始，再按结束；Esc 取消。';
    } catch (error) { this.state.shortcutNotice = (error as Error).message; }
    this.changed();
  }
  async removeShortcut(action: Action, id: string) {
    const next = this.settingsQueue.then(() => {
      const shortcuts = structuredClone(this.state.settings.shortcuts);
      shortcuts[action] = shortcuts[action].filter(key => shortcutID(key) !== id);
      return this.applySettings({ shortcuts });
    });
    this.settingsQueue = next.catch(() => {});
    return next;
  }
  async resetShortcut(action: Action) {
    const next = this.settingsQueue.then(() => {
      const shortcuts = structuredClone(this.state.settings.shortcuts);
      shortcuts[action] = defaultSettings().shortcuts[action];
      return this.applySettings({ shortcuts });
    });
    this.settingsQueue = next.catch(() => {});
    return next;
  }
  setPage(page: Page) { if (['desk', 'manuscripts', 'dictionary', 'settings'].includes(page)) { if (this.state.captureAction) void this.endCapture(); this.state.page = page; this.changed(); } }
  private async begin(action: Action, captured?: Destination, showOverlay = true): Promise<Task | undefined> {
    if (this.shuttingDown || busy(this.state.stage) || this.state.checking || this.state.captureAction) return;
    const needsAudio = action !== 'selectionTranslation' && showOverlay;
    const missingText = (action !== 'dictation' || !needsAudio) && this.state.runtime.capabilities.text === 'unavailable';
    const missingASR = needsAudio && this.state.runtime.capabilities.asr === 'unavailable';
    if (missingText || missingASR) {
      this.state.page = 'settings';
      this.notice(missingText
        ? '请先启动 AcpmRuntime 并准备文字模型，或在设置中启用在线文字处理 API。'
        : '请先启动 AcpmRuntime 并准备语音识别模型，或在设置中启用在线语音识别。');
      this.emit('reveal'); return;
    }
    this.observation = undefined;
    this.clearLearningNotice();
    if (this.state.platform === 'mac') void this.native.call('correction.stop').catch(() => {});
    clearTimeout(this.dismiss);
    const task: Task = { id: randomUUID(), action, abort: new AbortController(), settings: structuredClone(this.state.settings), destination: {}, lexicon: structuredClone(this.state.library.lexicon), started: Date.now(), manuscriptID: randomUUID(), original: '', asrResults: [] };
    this.task = task; this.state.action = action; this.state.stage = 'preparing'; this.state.notice = ''; this.state.liveTranscript = ''; this.state.level = 0; this.state.seconds = 0; this.state.overlayVisible = showOverlay && action !== 'selectionTranslation';
    this.changed();
    try {
      await this.cancelling;
      if (!this.valid(task)) return;
      task.destination = captured ?? await this.native.call<Destination>('capture', { readContext: task.settings.readContext });
      if (!this.valid(task)) return;
      this.state.destinationName = task.destination.name || '言墨文稿';
      await this.native.call('active', { value: true });
      if (!this.valid(task)) return;
      return task;
    } catch (error) { if (this.valid(task)) await this.fail(task, (error as Error).message); }
  }
  private valid(task: Task) { return this.task?.id === task.id; }
  private async handleAudioSegment(task: Task, wav: Buffer<ArrayBuffer>) {
    if (!this.valid(task) || task.abort.signal.aborted || !this.inference.transcribeSegment || !wav.length) return;
    try {
      const operation = task.action === 'voiceTranslation' ? 'voiceTranslation' : 'dictation';
      const seg = await this.inference.transcribeSegment(this.payload(task, operation), wav, task.original, task.abort.signal);
      if (!this.valid(task) || task.abort.signal.aborted || !seg.text) return;
      const delta = joinTranscriptDelta(task.original, seg.text);
      task.original = joinTranscript(task.original, seg.text);
      task.streamEngine = seg.engine;
      if (seg.language) {
        task.streamLanguage = seg.language;
        task.streamLanguageSource = seg.languageSource;
      }
      task.asrResults = [{
        engine_name: task.streamEngine || task.settings.acpm.asrModel,
        transcript: task.original,
        language: task.streamLanguage ?? null,
        language_source: task.streamLanguageSource ?? 'unknown',
      }];
      this.state.original = task.original;
      this.state.liveTranscript = task.original;
      const directCommit = task.writeToFocus === true && task.action === 'dictation' && !task.settings.polishEnabled;
      if (directCommit && delta) {
        const resp = await this.native.call<{ delivery?: string; name?: string; appKey?: string }>('insert', { text: delta });
        if (this.valid(task)) {
          task.committedStreamText = (task.committedStreamText ?? '') + delta;
          if (resp.name) task.streamDestinationName = resp.name;
          if (resp.appKey) task.streamAppKey = resp.appKey;
          if (resp.delivery === 'confirmed') task.streamConfirmed = true;
        }
      }
      if (this.valid(task)) this.changed();
    } catch (error) {
      if (task.abort.signal.aborted || !this.valid(task)) return;
      task.streamError = error instanceof Error ? error.message : '语音识别失败。';
    }
  }

  async perform(action: Action, destination?: Destination) {
    if (action === 'selectionTranslation') return this.translateSelection(destination);
    // The dictation key ends any recording; another action's key only ends its own.
    if (this.state.stage === 'recording') { if (action === 'dictation' || this.state.action === action) return this.finishRecording(); return; }
    const task = await this.begin(action, destination); if (!task) return;
    task.writeToFocus = true;
    this.state.selectedID = null; this.state.draft = ''; this.state.original = ''; this.state.liveTranscript = ''; this.state.asrResults = []; this.userEdited = false;
    try {
      await this.native.call('record.start', {
        device: task.settings.microphone,
        taskId: task.id,
        streamingVad: Boolean(this.inference.transcribeSegment),
      });
      if (!this.valid(task)) return;
      task.started = Date.now(); this.state.stage = 'recording'; this.changed();
      const prewarmAcpm = this.state.runtime.capabilities.asr === 'acpm'
        || (this.state.runtime.capabilities.text === 'acpm' && (action !== 'dictation' || task.settings.polishEnabled));
      if (prewarmAcpm) void this.inference.prewarm(task.settings, this.secrets(), action).catch(() => {});
      this.clock = setInterval(() => {
        if (!this.valid(task)) return;
        this.state.seconds = (Date.now() - task.started) / 1000; this.emit('meter', { level: this.state.level, seconds: this.state.seconds });
        if (this.state.seconds >= 300) void this.finishRecording();
      }, 200);
    } catch (error) { if (this.valid(task)) await this.fail(task, (error as Error).message); }
  }
  async finishRecording() {
    const task = this.task; if (!task || this.state.stage !== 'recording') return;
    task.recordingEndedAtMs = Date.now();
    const seconds = (task.recordingEndedAtMs - task.started) / 1000;
    clearInterval(this.clock); this.state.seconds = seconds;
    this.state.stage = 'transcribing'; this.state.level = 0; this.changed();
    let screenshot: Promise<Buffer | undefined> | undefined;
    try {
      let emittedSegments = 0;
      let tailAudioBase64: string | undefined;
      const recording = this.native.call<FinishedRecording>('record.finish').then(result => {
        // Keep any legacy path even on cancellation so finally can remove that file.
        task.audio = result.path;
        emittedSegments = result.emittedSegments ?? 0;
        tailAudioBase64 = result.tailAudioBase64;
        if (!this.valid(task)) return;
        if (!task.audio && typeof result.audioBase64 === 'string') {
          if (!result.audioBase64.length || result.audioBase64.length > Math.ceil(maxAudioBytes / 3) * 4) {
            throw new Error('音频大小无效，请分段处理。');
          }
          const wav = Buffer.from(result.audioBase64, 'base64');
          if (!wav.length || wav.length > maxAudioBytes) throw new Error('音频大小无效，请分段处理。');
          task.audio = wav;
          if (typeof result.seconds === 'number' && Number.isFinite(result.seconds) && result.seconds >= 0) {
            this.state.seconds = result.seconds;
          }
        }
      });
      if (seconds >= 0.35 && task.settings.keepHistory && task.settings.saveRecordingScreenshot) {
        screenshot = this.captureRecordingScreenshot?.().catch(() => undefined);
      }
      await recording;
      if (!this.valid(task)) return;
      await task.segmentChain;
      if (!this.valid(task)) return;
      const streamedCount = Math.max(emittedSegments, task.emittedSegments ?? 0);
      if (streamedCount > 0) {
        if (tailAudioBase64 && this.inference.transcribeSegment) {
          await this.handleAudioSegment(task, Buffer.from(tailAudioBase64, 'base64'));
        }
        if (!this.valid(task)) return;
        if (task.streamError && !task.original.trim()) throw new Error(task.streamError);
        if (!task.original.trim()) throw new Error('没有识别到语音，请靠近麦克风后重试。');
        task.pretranscribed = true;
      } else if (this.state.seconds < 0.35) {
        throw new Error('录音太短，请再说一句。');
      }
      await this.process(task, screenshot);
    } catch (error) {
      if (this.valid(task) && task.original && screenshot) task.screenshotImage = await screenshot;
      if (this.valid(task)) await this.fail(task, (error as Error).message);
    }
    finally { await this.deleteAudio(task); }
  }
  async importAudio(path: string) {
    const task = await this.begin('dictation', {}); if (!task) return;
    this.state.selectedID = null; this.state.draft = ''; this.state.original = ''; this.state.asrResults = []; this.userEdited = false;
    try {
      const audio = await this.native.call<{ path: string; seconds: number }>('audio.import', { path }); task.audio = audio.path;
      if (!this.valid(task)) return;
      this.state.seconds = audio.seconds;
      await this.process(task);
    } catch (error) { if (this.valid(task)) await this.fail(task, (error as Error).message); }
    finally { await this.deleteAudio(task); }
  }
  private payload(task: Task, operation: InferenceTaskPayload['operation'], text = '', language?: Language): InferenceTaskPayload {
    const scope = scopedTerms(task.lexicon, task.destination.category);
    const voice = operation === 'dictation' || operation === 'voiceTranslation';
    return {
      task_id: task.id, operation, text: task.pretranscribed ? task.original : text, target_language: language ?? task.settings.voiceTarget,
      asr_results: (operation === 'polish' || task.pretranscribed) ? task.asrResults : [],
      ...(task.pretranscribed ? { pretranscribed: true } : {}),
      polish: task.settings.polishEnabled, style: task.settings.style,
      archive_audio: task.settings.keepHistory && voice,
      ...(voice ? { asr_hotwords: selectASRHotwords(scope) } : {}),
      acpm: task.settings.acpm,
      acpmToken: this.acpmToken,
      acpmTextReady: this.state.runtime.capabilities.text === 'acpm',
      acpmVadReady: this.state.acpm.vadReady,
      online: Object.fromEntries((Object.keys(task.settings.online) as Capability[]).filter(capability => task.settings.online[capability].enabled &&
        (capability !== 'text' || operation !== 'dictation' || task.settings.polishEnabled))
        .map(capability => [capability, { base_url: task.settings.online[capability].baseURL, model: task.settings.online[capability].model.trim(), api_key: this.keys[capability] || '' }])),
      context: {
        application: task.destination.name || '言墨',
        category: task.destination.category || 'general',
        lexicon: [...scope.application, ...scope.global].map(({ term, hint, aliases }) => ({ term, hint: hint || '', aliases: aliases || [] })),
        before: task.settings.readContext ? (task.destination.before || '').slice(-300) : '',
        after: task.settings.readContext ? (task.destination.after || '').slice(0, 300) : '',
        ...(task.userText ? { user_text: task.userText } : {}),
      },
    };
  }
  private async collect(task: Task, operation: InferenceTaskPayload['operation'], text = '', language?: Language) {
    let result: TaskEvent | undefined;
    const running = this.inference.run(this.payload(task, operation, text, language), task.audio, event => {
      if (!this.valid(task)) return;
      if (event.event === 'stage' && ['transcribing', 'polishing', 'translating'].includes(event.stage || '')) { this.state.stage = event.stage!; this.changed(); }
      if (event.event === 'transcript') {
        task.original = event.text || '';
        task.asrResults = structuredClone(event.asr_results || []);
        this.state.original = task.original; this.state.asrResults = task.asrResults; this.changed();
      }
      if (event.event === 'audio') {
        if (event.audio_opus) task.audioOpus = Buffer.from(event.audio_opus, 'base64');
        if (event.audio_warning) { task.audioWarning = event.audio_warning; this.notice(event.audio_warning); }
      }
      if (['result', 'error', 'cancelled'].includes(event.event)) result = event;
    }, task.abort.signal);
    if (Buffer.isBuffer(task.audio)) task.audio = undefined;
    await running;
    if (!this.valid(task)) return;
    if (!result || result.event !== 'result' || !result.text) throw new Error(result?.message || '处理未完成，已保留原文。');
    return result;
  }
  private saveTask(task: Task, text: string, processed: boolean, matches?: Set<string>) {
    this.state.draft = text; this.state.original = task.original; this.state.asrResults = task.asrResults; this.state.selectedID = task.manuscriptID;
    this.userEdited = !!task.userText;
    const previous = this.state.library;
    let lexicon = previous.lexicon;
    if (matches?.size) {
      const now = Date.now();
      lexicon = lexicon.map(entry => matches.has(entry.id)
        ? { ...entry, matchCount: (entry.matchCount ?? 0) + 1, lastMatchedAt: now }
        : entry);
    }
    if (task.settings.keepHistory) {
      const existing = previous.manuscripts.find(value => value.id === task.manuscriptID);
      const item: Manuscript = { ...existing, id: task.manuscriptID, date: cocoaNow(), original: task.original, text, seconds: this.state.seconds, application: task.destination.name || '言墨文稿', polished: processed, asrResults: structuredClone(task.asrResults), userEdited: this.userEdited, ...(task.audioWarning ? { audioWarning: task.audioWarning } : {}), ...(task.recordingEndedAtMs ? { recordingEndedAtMs: task.recordingEndedAtMs } : {}) };
      this.state.library = { lexicon, manuscripts: [item, ...previous.manuscripts.filter(value => value.id !== item.id)] };
      this.store.library = this.state.library; this.store.prune(); this.state.library = this.store.library;
      const audioOpus = task.audioOpus?.length ? task.audioOpus : undefined;
      const screenshotImage = task.screenshotImage?.length ? task.screenshotImage : undefined;
      if (!this.persist(audioOpus || screenshotImage ? { id: task.manuscriptID, audioOpus, screenshotImage } : undefined)) {
        this.state.library = this.store.library = previous;
        this.state.selectedID = null;
        return false;
      }
    } else if (lexicon !== previous.lexicon) {
      this.state.library = { ...previous, lexicon };
      if (!this.persist()) {
        this.state.library = this.store.library = previous;
        this.state.notice = '本次词库命中记录未保存。';
      }
    }
    return true;
  }
  private delivery(message: string) { const item = this.state.library.manuscripts.find(value => value.id === this.state.selectedID); if (item) { item.deliveryNote = message; this.persist(); } }
  private recordAppInput(event: AppInputEvent) {
    if (!event.eventId || !event.appKey || !Number.isSafeInteger(event.occurredAtMs) ||
        !Number.isSafeInteger(event.characters) || event.characters <= 0) return;
    try { this.store.recordAppInput(event); }
    catch { this.notice('本次应用发送字数未能保存。'); }
  }
  private async process(task: Task, screenshot?: Promise<Buffer | undefined>) {
    const result = await this.collect(task, task.action === 'voiceTranslation' ? 'voiceTranslation' : 'dictation');
    if (!result || !this.valid(task)) return;
    if (screenshot) task.screenshotImage = await screenshot;
    if (!this.valid(task)) return;
    if (screenshot && !task.screenshotImage?.length) this.state.notice = '本次未能保存截屏，文字处理继续。';
    // Only successful live dictation counts. Rank against every in-scope term,
    // including those that did not fit in this recording's ASR prompt.
    const scope = scopedTerms(task.lexicon, task.destination.category);
    const matches = task.writeToFocus && task.action === 'dictation'
      ? matchedTermIDs([...scope.application, ...scope.global], result.text!) : undefined;
    this.saveTask(task, result.text!, result.processed === true, matches);
    if (task.writeToFocus) {
      if (task.committedStreamText && !task.settings.polishEnabled && task.action === 'dictation') {
        const characters = characterCount(result.text!);
        const appName = task.streamDestinationName || task.destination.name || '当前应用';
        this.recordAppInput({
          eventId: task.id,
          occurredAtMs: Date.now(),
          appKey: task.streamAppKey || 'name:' + appName,
          appName,
          characters,
          confirmed: task.streamConfirmed === true,
        });
        this.state.destinationName = appName;
        const item = this.state.library.manuscripts.find(value => value.id === task.manuscriptID);
        if (item) item.application = appName;
        if (task.streamConfirmed) {
          this.delivery('文字已写入' + this.state.destinationName + '。'); this.state.stage = 'success';
        } else {
          this.delivery('已向当前输入位置发送一次粘贴。'); this.state.stage = 'idle';
        }
        if (appName === '言墨') { this.state.page = 'manuscripts'; this.emit('reveal'); }
      } else {
        this.state.stage = 'inserting'; this.changed();
        try {
          const observationId = task.action === 'dictation' && this.state.platform === 'mac' && this.state.runtime.capabilities.text !== 'unavailable' ? task.id : undefined;
          this.observation = observationId ? { id: observationId, group: termGroup(task.destination.category) } : undefined;
          const transcript = task.original !== result.text && task.original.length <= 2000 ? task.original : undefined;
          const characters = characterCount(result.text!);
          const response = await this.native.call<{ delivery: string; message?: string; name?: string; appKey?: string; dispatchReported?: boolean }>('insert', {
            text: result.text, inputEventId: task.id, characterCount: characters, ...(observationId ? { observationId, transcript } : {}),
          });
          if (response.delivery === 'confirmed' || (response.delivery === 'attempted_unverified' && !response.dispatchReported)) {
            const appName = response.name || '当前应用';
            this.recordAppInput({ eventId: task.id, occurredAtMs: Date.now(), appKey: response.appKey || 'name:' + appName,
              appName, characters, confirmed: response.delivery === 'confirmed' });
          }
          if (!this.valid(task)) return;
          if (response.name) {
            this.state.destinationName = response.name;
            const item = this.state.library.manuscripts.find(value => value.id === task.manuscriptID);
            if (item) item.application = response.name;
          }
          if (response.delivery === 'confirmed') {
            this.delivery('文字已写入' + this.state.destinationName + '。'); this.state.stage = 'success';
          } else {
            this.delivery(response.message || '已向当前输入位置发送一次粘贴。'); this.state.stage = 'idle';
          }
          if (response.name === '言墨') { this.state.page = 'manuscripts'; this.emit('reveal'); }
        } catch (error) {
          if (!this.valid(task)) return;
          this.delivery('未写入：' + (error as Error).message); await this.fail(task, (error as Error).message); return;
        }
      }
    } else { this.state.stage = 'idle'; this.state.page = 'manuscripts'; this.emit('reveal'); }
    await this.finishTask(task);
    if (this.state.stage === 'success') this.scheduleDismiss(1500);
    this.changed();
  }
  async translateSelection(destination?: Destination) {
    const task = await this.begin('selectionTranslation', destination); if (!task) return;
    this.state.translation = { source: '', result: '', language: task.settings.selectionTarget, loading: true, error: '' }; this.changed();
    try {
      let text: string;
      if (task.destination.id) ({ text } = await this.native.call<{ text: string }>('selection', { destinationId: task.destination.id }));
      else {
        // Native capture skips 言墨's own windows, so a selection there (e.g. the guide's practice field) is read from the page.
        text = (await this.ownSelection?.())?.trim() || '';
        if (!text) throw new Error('请先选中文字，再按划词翻译快捷键。');
        if ([...text].length > 4000) throw new Error('单次支持 4000 字以内的翻译，请缩小选区。');
      }
      if (!this.valid(task)) return;
      this.state.translation.source = text; this.emit('translationShow'); this.changed();
      await this.translate(task, text, task.settings.selectionTarget);
    } catch (error) {
      if (this.valid(task)) { this.state.translation.error = (error as Error).message; this.state.translation.loading = false; this.state.stage = 'idle'; await this.finishTask(task); this.emit('translationShow'); this.changed(); }
    }
  }
  private async translate(task: Task, text: string, language: Language) {
    try {
      const result = await this.collect(task, 'selectionTranslation', text, language);
      if (result && this.valid(task)) this.state.translation.result = result.text!;
    } catch (error) { if (this.valid(task)) this.state.translation.error = (error as Error).message; }
    if (this.valid(task)) { this.state.translation.loading = false; this.state.stage = 'idle'; await this.finishTask(task); this.changed(); }
  }
  async retryTranslation(language: Language) {
    if (!Object.hasOwn(LANGUAGES, language) || !this.state.translation.source) return;
    const task = await this.begin('selectionTranslation', {}); if (!task) return;
    this.state.translation.language = language; this.state.translation.loading = true; this.state.translation.error = ''; this.state.translation.result = ''; this.changed();
    await this.translate(task, this.state.translation.source, language);
  }
  async closeTranslation() {
    if (this.task?.action === 'selectionTranslation') await this.cancel();
    this.state.translation = { source: '', result: '', language: this.state.settings.selectionTarget, loading: false, error: '' }; this.changed();
  }
  async polishDraft() {
    if (!this.state.draft) return;
    const text = this.state.draft; const selected = this.state.selectedID;
    const task = await this.begin('dictation', {}, false); if (!task) return;
    task.manual = true; task.asrResults = structuredClone(this.state.asrResults); task.original = this.state.original;
    if (selected) task.manuscriptID = selected;
    if (this.userEdited) task.userText = text;
    try {
      const result = await this.collect(task, 'polish', text);
      if (!result || !this.valid(task)) return;
      this.state.draft = result.text!; this.state.selectedID = selected;
      const item = this.state.library.manuscripts.find(value => value.id === selected);
      let saved = true;
      if (item) { item.text = result.text!; item.polished = true; saved = this.persist(); }
      this.state.stage = 'idle';
      if (saved) this.state.notice = '文字已整理完成，请核对正文。';
      await this.finishTask(task); this.changed();
    } catch (error) { if (this.valid(task)) { this.state.stage = 'idle'; await this.finishTask(task); this.notice((error as Error).message); } }
  }
  private async fail(task: Task, message: string) {
    if (!this.valid(task)) return;
    const saved = !task.original || this.saveTask(task, task.original, false);
    const notice = saved ? message : message + ' ' + this.state.notice;
    this.state.stage = 'failure'; this.state.notice = notice; this.state.liveTranscript = ''; this.state.level = 0;
    await this.finishTask(task); this.scheduleDismiss(3500); this.changed();
  }
  private scheduleDismiss(ms: number) {
    clearTimeout(this.dismiss);
    this.dismiss = setTimeout(() => { if (!this.task && ['success', 'failure'].includes(this.state.stage)) { this.state.stage = 'idle'; this.changed(); } }, ms);
  }
  private async finishTask(task: Task) {
    if (!this.valid(task)) return;
    clearInterval(this.clock); this.task = undefined; this.state.liveTranscript = '';
    await this.native.call('active', { value: false }).catch(() => {});
  }
  private async deleteAudio(task: Task) {
    const path = typeof task.audio === 'string' ? task.audio : undefined;
    task.audio = undefined;
    if (path) await this.native.call('audio.delete', { path }).catch(() => {});
  }
  async cancel() {
    clearTimeout(this.dismiss);
    const task = this.task;
    if (!task) { this.state.stage = 'idle'; this.state.liveTranscript = ''; this.state.overlayVisible = false; this.changed(); return; }
    this.task = undefined; task.abort.abort(); clearInterval(this.clock); this.state.level = 0; this.state.stage = 'idle'; this.state.liveTranscript = ''; this.state.overlayVisible = false;
    if (task.action === 'selectionTranslation') { this.state.translation.loading = false; this.state.translation.error = '已取消翻译。'; }
    else if (task.manual) this.state.notice = '已停止整理，当前文稿已保留。';
    else if (task.original) { const saved = this.saveTask(task, task.original, false); this.state.notice = saved ? '已停止整理，识别原文已保留。' : '已停止整理。' + this.state.notice; }
    else this.state.notice = '已取消，本次录音已丢弃。';
    this.cancelling = Promise.all([this.native.call('record.cancel').catch(() => {}), this.native.call('active', { value: false }).catch(() => {}), this.inference.cancel(task.id)]);
    this.changed(); await this.cancelling;
  }
  select(id: string) {
    if (busy(this.state.stage)) return;
    const item = this.state.library.manuscripts.find(value => value.id === id);
    if (item) { this.state.selectedID = id; this.state.draft = item.text; this.state.original = item.original; this.state.asrResults = structuredClone(item.asrResults || []); this.userEdited = item.userEdited === true; this.state.page = 'manuscripts'; this.changed(); }
  }
  reloadLibraryFromStore() {
    this.state.library = this.store.library;
    this.remoteRevision = this.store.remoteRevision;
    if (this.state.selectedID) {
      const selected = this.state.library.manuscripts.find(value => value.id === this.state.selectedID);
      if (selected) {
        this.state.draft = selected.text;
        this.state.original = selected.original;
        this.state.asrResults = structuredClone(selected.asrResults || []);
        this.userEdited = selected.userEdited === true;
      } else {
        this.state.selectedID = null;
        this.state.draft = '';
        this.state.original = '';
        this.state.asrResults = [];
        this.userEdited = false;
      }
    }
    this.changed();
  }
  updateDraft(id: string | null, text: string) {
    if (busy(this.state.stage) || id !== this.state.selectedID || typeof text !== 'string') return;
    if (text !== this.state.draft) this.userEdited = true;
    this.state.draft = text;
    const item = this.state.library.manuscripts.find(value => value.id === id);
    if (item) { item.text = text; item.userEdited = this.userEdited; this.persist(); }
    this.changed();
  }
  deleteManuscript(id: string) {
    if (busy(this.state.stage)) return;
    this.state.library.manuscripts = this.state.library.manuscripts.filter(item => item.id !== id);
    if (this.state.selectedID === id) { this.state.selectedID = null; this.state.draft = ''; this.state.original = ''; this.state.asrResults = []; this.userEdited = false; }
    this.persist(); this.changed();
  }
  saveTerm(value: { id?: string; term: string; hint: string; aliases: string[]; group?: TermGroup }) {
    if (busy(this.state.stage)) return;
    const term = value.term.trim(); if (!term) throw new Error('请填写词语。');
    if (value.group !== undefined && !isTermGroup(value.group)) throw new Error('词条范围无效。');
    const previous = this.state.library.lexicon;
    const existing = previous.find(item => item.id === value.id);
    const group = value.group ?? existing?.group ?? 'global';
    const key = termKey(term);
    const aliases = [...new Map(value.aliases.map(alias => [termKey(alias), alias.trim()])).entries()]
      .filter(([alias]) => alias && alias !== key).map(([, alias]) => alias);
    const others = previous.filter(item => item.id !== value.id && termGroup(item.group) === group);
    if (others.some(item => termKey(item.term) === key)) throw new Error('这个范围已有同名词条。');
    const aliasKeys = new Set(aliases.map(termKey));
    if (others.some(item => aliasKeys.has(termKey(item.term)) || item.aliases?.some(alias => termKey(alias) === key || aliasKeys.has(termKey(alias))))) {
      throw new Error('这条误识别已属于同一范围的另一个词条，请避免冲突。');
    }
    const stats = existing && termKey(existing.term) === key && termGroup(existing.group) === group
      ? existing : { createdAt: Date.now() };
    const entry: Term = { ...stats, id: existing?.id ?? randomUUID(), term, hint: value.hint.trim(), aliases, group };
    this.state.library.lexicon = existing ? previous.map(item => item.id === entry.id ? entry : item) : [...previous, entry];
    if (!this.persist()) { this.state.library.lexicon = previous; this.changed(); throw new Error('词条未保存，请重试。'); }
    this.changed();
  }
  removeTerm(id: string) { if (busy(this.state.stage)) return; this.state.library.lexicon = this.state.library.lexicon.filter(item => item.id !== id); this.persist(); this.changed(); }
  private clearLearningNotice() {
    clearTimeout(this.learningDismiss); this.state.learnedTerms = undefined; this.learned = [];
  }
  private async learnCorrections(value: { observationId: string; original: string; text: string; transcript?: string }) {
    const observation = this.observation;
    if (!observation || value.observationId !== observation.id) return;
    this.observation = undefined;
    if (typeof value.original !== 'string' || typeof value.text !== 'string' || value.original === value.text || !value.text.trim()) return;
    if (this.state.runtime.capabilities.text === 'unavailable' || this.shuttingDown) return;
    let candidates: string[];
    try {
      candidates = await this.inference.extractCorrectionTerms(
        value.original,
        value.text,
        this.state.settings,
        this.secrets(),
        typeof value.transcript === 'string' && value.transcript ? value.transcript : undefined,
      );
    } catch { return; }
    if (this.shuttingDown || decideRuntime(this.state.settings.online, this.state.acpm).capabilities.text === 'unavailable') return;
    const scope = scopedTerms(this.state.library.lexicon, observation.group);
    const seen = new Set([...scope.application, ...scope.global].map(item => termKey(item.term)));
    const terms = candidates.filter(term => {
      const key = termKey(term);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!terms.length) return;
    const added = terms.map(term => ({ id: randomUUID(), term, hint: '', aliases: [], group: observation.group, createdAt: Date.now() }));
    const previous = this.state.library.lexicon;
    this.state.library.lexicon = [...previous, ...added]; this.store.library = this.state.library;
    try { this.store.persist(); }
    catch { this.state.library.lexicon = previous; this.notice('词库保存失败，本次纠词未收录。'); return; }
    this.learned.push(...added);
    clearTimeout(this.learningDismiss); this.state.learnedTerms = undefined;
    this.changed();
  }
  undoLearnedTerms() {
    const added = new Map(this.learned.map(item => [item.id, JSON.stringify(item)]));
    const previous = this.state.library.lexicon;
    this.state.library.lexicon = previous.filter(item => added.get(item.id) !== JSON.stringify(item));
    this.store.library = this.state.library;
    try { this.store.persist(); }
    catch { this.state.library.lexicon = previous; this.notice('撤销未保存，请重试。'); return; }
    this.clearLearningNotice(); this.changed();
  }
  async shutdown() { this.shuttingDown = true; this.observation = undefined; this.clearLearningNotice(); clearTimeout(this.dismiss); clearInterval(this.clock); await this.cancel(); this.native.stop(); this.store.close(); }
}
