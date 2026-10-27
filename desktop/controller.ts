import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ACTIONS, Action, AppState, ASRResult, Capability, CAPABILITIES, busy, cocoaNow, defaultSettings, Destination, Language, LANGUAGES, LocalEnvironment, Manuscript, NativeStatus, Page, Settings, Shortcut, shortcutID, TaskEvent, Term, validateSettings } from './shared';
import { BackendClient, NativeBridge } from './processes';
import { LibraryStore } from './store';
import { decideRuntime } from './precheck';

interface Task {
  id: string; action: Action; settings: Settings; destination: Destination; lexicon: Term[];
  started: number; manuscriptID: string; original: string; asrResults: ASRResult[]; audio?: string;
  userText?: string; manual?: boolean; writeToFocus?: boolean;
}

export class Controller extends EventEmitter {
  readonly state: AppState;
  private task?: Task;
  private userEdited = false;
  private clock?: NodeJS.Timeout;
  private dismiss?: NodeJS.Timeout;
  private cancelling?: Promise<unknown>;
  private settingsQueue: Promise<unknown> = Promise.resolve();
  /** Selected text in 言墨's focused main window, if any. */
  ownSelection?: () => Promise<string>;
  /** Set on Windows: probes the GPU and the PyTorch CUDA runtime instead of asking the backend for MLX caches. */
  windowsPrecheck?: () => Promise<LocalEnvironment>;
  /** Set on Windows: cache completeness of the transformers-format models, checked with the PyTorch runtime. */
  windowsModels?: (settings: Settings) => Promise<{ asr: boolean; llm: boolean }>;
  environment?: LocalEnvironment;
  constructor(readonly store: LibraryStore, readonly native: NativeBridge, readonly backend: BackendClient) {
    super();
    this.state = {
      page: 'desk', stage: 'idle', action: 'dictation', settings: store.settings, library: store.library,
      selectedID: null, draft: '', original: '', asrResults: [], notice: store.error, seconds: 0, level: 0,
      destinationName: '言墨文稿', checking: false, modelsChecked: false, overlayVisible: false, models: { asr: false, sensevoice: false, llm: false, metal: false },
      native: { accessibility: false, eventTap: false, microphone: 0, devices: [] },
      translation: { source: '', result: '', language: store.settings.selectionTarget, loading: false, error: '' },
      captureAction: null, shortcutNotice: '', launchAtLogin: false, onlineKeys: { asr: false, text: false },
      runtime: decideRuntime(store.settings.online, { asr: false, text: false }), platform: 'mac',
    };
    native.on('shortcut', ({ action, destination }: { action: Action; destination: Destination }) => {
      if (action in ACTIONS) void this.perform(action, destination);
    });
    native.on('cancel', () => void this.cancel());
    native.on('permissions', () => void this.permissions());
    native.on('meter', ({ taskId, level }: { taskId: string; level: number }) => {
      if (this.task?.id === taskId && this.state.stage === 'recording') { this.state.level = Math.min(1, Math.max(0, Number(level) || 0)); this.emit('meter', { level: this.state.level, seconds: this.state.seconds }); }
    });
    native.on('shortcutCaptured', ({ shortcut }: { shortcut?: Shortcut }) => {
      if (!shortcut) void this.endCapture();
      else void this.saveCaptured(shortcut);
    });
    native.on('fault', () => { if (busy(this.state.stage)) void this.cancel(); this.notice('系统桥接已退出，请重新检查权限或重启言墨。'); });
  }
  private keys: Partial<Record<Capability, string>> = {};
  /** Decrypted by the main process; the renderer only learns whether a key exists. */
  setOnlineKeys(keys: Partial<Record<Capability, string>>) { this.keys = keys; this.state.onlineKeys = { asr: !!keys.asr, text: !!keys.text }; this.changed(); }
  changed() { this.emit('state', this.state); }
  private refreshRuntime() {
    const { models } = this.state;
    // Windows has no SenseVoice review, so its local ASR needs only the ASR model.
    this.state.runtime = decideRuntime(this.state.settings.online, { asr: models.asr && (models.sensevoice || !!this.windowsPrecheck), text: models.llm }, this.environment);
  }
  notice(message: string) { this.state.notice = message; this.changed(); }
  private persist() {
    this.store.library = this.state.library; this.store.settings = this.state.settings;
    try { this.store.persist(); } catch (error) { this.state.notice = (error as Error).message; }
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
    if (busy(this.state.stage) || this.state.checking || this.state.captureAction) return;
    const settings = structuredClone(this.state.settings);
    this.state.checking = true; this.changed();
    try {
      await this.cancelling;
      if (this.windowsPrecheck) {
        // No MLX on Windows: the backend is not started just to look for caches.
        const [environment, native] = await Promise.all([this.windowsPrecheck(), this.native.call<NativeStatus>('status')]);
        const cached = environment.environment === 'ready' && this.windowsModels ? await this.windowsModels(settings) : { asr: false, llm: false };
        this.environment = environment; this.state.native = native;
        this.state.models = { asr: cached.asr, sensevoice: false, llm: cached.llm, metal: false }; this.refreshRuntime();
        const { status, issues } = this.state.runtime;
        if (status === 'recommend-online') this.state.notice = '未检测到可用的 NVIDIA CUDA 环境，建议在设置中配置在线语音识别与文字处理；配置前不会上传任何内容。';
        else if (status === 'local-repair') this.state.notice = issues.join(' ') + ' 也可在设置中改用在线处理。';
        return;
      }
      const [value, native] = await Promise.all([this.backend.status(settings), this.native.call<NativeStatus>('status')]);
      if (settings.asrModel !== this.state.settings.asrModel || settings.llmModel !== this.state.settings.llmModel || settings.senseVoiceModel !== this.state.settings.senseVoiceModel || settings.modelSource !== this.state.settings.modelSource) return;
      this.state.native = native;
      this.state.models = { asr: value.models?.asr?.ready === true, sensevoice: value.models?.sensevoice?.ready === true, llm: value.models?.llm?.ready === true, metal: value.metal === true };
      this.environment = value.metal ? { environment: 'ready', issues: [] } : { environment: 'repair', issues: ['MLX 尚未检测到可用的 Metal 环境。'] };
      this.refreshRuntime();
      if (!value.metal) this.state.notice = 'MLX 尚未检测到可用的 Metal 环境。';
    } catch (error) { this.state.notice = (error as Error).message; }
    finally { this.state.checking = false; this.state.modelsChecked = true; this.changed(); }
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
    const modelsChanged = proposed.asrModel !== this.state.settings.asrModel || proposed.llmModel !== this.state.settings.llmModel || proposed.senseVoiceModel !== this.state.settings.senseVoiceModel || proposed.modelSource !== this.state.settings.modelSource;
    this.state.settings = proposed; this.state.native = native;
    this.store.settings = proposed; this.store.library = this.state.library; this.store.prune(); this.state.library = this.store.library;
    if (this.state.selectedID && !this.state.library.manuscripts.some(item => item.id === this.state.selectedID)) { this.state.selectedID = null; this.state.draft = ''; this.state.original = ''; this.state.asrResults = []; this.userEdited = false; }
    if (modelsChanged) this.state.models = { asr: false, sensevoice: false, llm: false, metal: false };
    this.refreshRuntime();
    this.persist(); this.changed(); this.emit('preferences', proposed);
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
    const shortcuts = structuredClone(this.state.settings.shortcuts);
    shortcuts[action] = shortcuts[action].filter(key => shortcutID(key) !== id);
    await this.updateSettings({ shortcuts });
  }
  setPage(page: Page) { if (['desk', 'manuscripts', 'dictionary', 'settings'].includes(page)) { if (this.state.captureAction) void this.endCapture(); this.state.page = page; this.changed(); } }
  private async begin(action: Action, captured?: Destination, showOverlay = true): Promise<Task | undefined> {
    if (busy(this.state.stage) || this.state.checking || this.state.captureAction) return;
    // Windows without a usable local runtime never records until the user enables the missing online capability.
    // Without the overlay (manual polish) only text generation is needed.
    const missing = (action === 'selectionTranslation' || !showOverlay ? ['text'] as const : ['asr', 'text'] as const).filter(name => this.state.runtime.capabilities[name] === 'unavailable');
    if (this.windowsPrecheck && missing.length) {
      this.state.page = 'settings'; this.notice('请先在设置中启用在线' + missing.map(name => CAPABILITIES[name]).join('与') + '；配置前不会上传任何内容。'); this.emit('reveal'); return;
    }
    clearTimeout(this.dismiss);
    const task: Task = { id: randomUUID(), action, settings: structuredClone(this.state.settings), destination: {}, lexicon: structuredClone(this.state.library.lexicon), started: Date.now(), manuscriptID: randomUUID(), original: '', asrResults: [] };
    this.task = task; this.state.action = action; this.state.stage = 'preparing'; this.state.notice = ''; this.state.level = 0; this.state.seconds = 0; this.state.overlayVisible = showOverlay && action !== 'selectionTranslation';
    this.backend.setActive(true); this.changed();
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
  async perform(action: Action, destination?: Destination) {
    if (action === 'selectionTranslation') return this.translateSelection(destination);
    // The dictation key ends any recording; another action's key only ends its own.
    if (this.state.stage === 'recording') { if (action === 'dictation' || this.state.action === action) return this.finishRecording(); return; }
    const task = await this.begin(action, destination); if (!task) return;
    task.writeToFocus = true;
    this.state.selectedID = null; this.state.draft = ''; this.state.original = ''; this.state.asrResults = []; this.userEdited = false;
    try {
      await this.native.call('record.start', { device: task.settings.microphone, taskId: task.id });
      if (!this.valid(task)) return;
      task.started = Date.now(); this.state.stage = 'recording'; this.changed();
      if (this.state.runtime.capabilities.asr === 'local') void this.backend.warmup(task.settings, !task.settings.online.text.enabled).catch(() => {});
      this.clock = setInterval(() => {
        if (!this.valid(task)) return;
        this.state.seconds = (Date.now() - task.started) / 1000; this.emit('meter', { level: this.state.level, seconds: this.state.seconds });
        if (this.state.seconds >= 300) void this.finishRecording();
      }, 200);
    } catch (error) { if (this.valid(task)) await this.fail(task, (error as Error).message); }
  }
  async finishRecording() {
    const task = this.task; if (!task || this.state.stage !== 'recording') return;
    clearInterval(this.clock); this.state.seconds = (Date.now() - task.started) / 1000;
    this.state.stage = 'transcribing'; this.state.level = 0; this.changed();
    try {
      const { path } = await this.native.call<{ path: string }>('record.finish'); task.audio = path;
      if (!this.valid(task)) return;
      if (this.state.seconds < 0.35) throw new Error('录音太短，请再说一句。');
      await this.process(task, 'dictation');
    } catch (error) { if (this.valid(task)) await this.fail(task, (error as Error).message); }
    finally { await this.deleteAudio(task); }
  }
  async importAudio(path: string) {
    const task = await this.begin('dictation', {}); if (!task) return;
    this.state.selectedID = null; this.state.draft = ''; this.state.original = ''; this.state.asrResults = []; this.userEdited = false;
    try {
      const audio = await this.native.call<{ path: string; seconds: number }>('audio.import', { path }); task.audio = audio.path;
      if (!this.valid(task)) return;
      this.state.seconds = audio.seconds;
      await this.process(task, 'dictation');
    } catch (error) { if (this.valid(task)) await this.fail(task, (error as Error).message); }
    finally { await this.deleteAudio(task); }
  }
  private payload(task: Task, operation: string, text = '', language?: Language) {
    return {
      task_id: task.id, operation, text, target_language: language ?? task.settings.voiceTarget,
      asr_results: operation === 'polish' ? task.asrResults : [],
      polish: task.settings.polishEnabled, style: task.settings.style,
      models: { asr_model: task.settings.asrModel, llm_model: task.settings.llmModel, sensevoice_model: task.settings.senseVoiceModel, model_source: task.settings.modelSource },
      online: Object.fromEntries((Object.keys(task.settings.online) as Capability[]).filter(capability => task.settings.online[capability].enabled)
        .map(capability => [capability, { base_url: task.settings.online[capability].baseURL, model: task.settings.online[capability].model.trim(), api_key: this.keys[capability] || '' }])),
      context: { application: task.destination.name || '言墨', category: task.destination.category || 'general', before: task.settings.readContext ? (task.destination.before || '').slice(-300) : '', after: task.settings.readContext ? (task.destination.after || '').slice(0, 300) : '',
        key_terms: task.lexicon.map(item => item.term), term_notes: task.lexicon.map(({ term, hint }) => ({ term, hint })), lexicon: task.lexicon.map(({ term, aliases }) => ({ term, aliases: aliases || [] })), ...(task.userText ? { user_text: task.userText } : {}) },
    };
  }
  private async collect(task: Task, operation: string, text = '', language?: Language) {
    let result: TaskEvent | undefined;
    await this.backend.run(this.payload(task, operation, text, language), task.audio, event => {
      if (!this.valid(task)) return;
      if (event.event === 'stage' && ['transcribing', 'reviewing', 'polishing', 'translating'].includes(event.stage || '')) { this.state.stage = event.stage!; this.changed(); }
      if (event.event === 'transcript') { task.original = event.text || ''; task.asrResults = structuredClone(event.asr_results || []); this.state.original = task.original; this.state.asrResults = task.asrResults; this.changed(); }
      if (['result', 'error', 'cancelled'].includes(event.event)) result = event;
    });
    if (!this.valid(task)) return;
    if (!result || result.event !== 'result' || !result.text) throw new Error(result?.message || '处理未完成，已保留原文。');
    return result;
  }
  private saveTask(task: Task, text: string, processed: boolean) {
    this.state.draft = text; this.state.original = task.original; this.state.asrResults = task.asrResults; this.state.selectedID = task.manuscriptID;
    this.userEdited = !!task.userText;
    if (task.settings.keepHistory) {
      const item: Manuscript = { id: task.manuscriptID, date: cocoaNow(), original: task.original, text, seconds: this.state.seconds, application: task.destination.name || '言墨文稿', polished: processed, asrResults: structuredClone(task.asrResults), userEdited: this.userEdited };
      const previous = this.state.library.manuscripts.find(value => value.id === item.id);
      if (previous) Object.assign(previous, item); else this.state.library.manuscripts.unshift(item);
      this.store.library = this.state.library; this.store.prune(); this.state.library = this.store.library; this.persist();
    }
  }
  private delivery(message: string) { const item = this.state.library.manuscripts.find(value => value.id === this.state.selectedID); if (item) { item.deliveryNote = message; this.persist(); } }
  private async process(task: Task, _operation: string) {
    const result = await this.collect(task, task.action === 'voiceTranslation' ? 'voiceTranslation' : 'dictation');
    if (!result || !this.valid(task)) return;
    this.saveTask(task, result.text!, result.processed === true);
    if (task.writeToFocus) {
      this.state.stage = 'inserting'; this.changed();
      try {
        const response = await this.native.call<{ delivery: string; message?: string; name?: string }>('insert', { text: result.text });
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
      if (item) { item.text = result.text!; item.polished = true; this.persist(); }
      this.state.stage = 'idle'; this.state.notice = '文字已在本机整理完成，请核对正文。'; await this.finishTask(task); this.changed();
    } catch (error) { if (this.valid(task)) { this.state.stage = 'idle'; await this.finishTask(task); this.notice((error as Error).message); } }
  }
  private async fail(task: Task, message: string) {
    if (!this.valid(task)) return;
    if (task.original) this.saveTask(task, task.original, false);
    this.state.stage = 'failure'; this.state.notice = message; this.state.level = 0;
    await this.finishTask(task); this.scheduleDismiss(3500); this.changed();
  }
  private scheduleDismiss(ms: number) {
    clearTimeout(this.dismiss);
    this.dismiss = setTimeout(() => { if (!this.task && ['success', 'failure'].includes(this.state.stage)) { this.state.stage = 'idle'; this.changed(); } }, ms);
  }
  private async finishTask(task: Task) {
    if (!this.valid(task)) return;
    clearInterval(this.clock); this.task = undefined; this.backend.setActive(false);
    await this.native.call('active', { value: false }).catch(() => {});
  }
  private async deleteAudio(task: Task) { if (task.audio) await this.native.call('audio.delete', { path: task.audio }).catch(() => {}); }
  async cancel() {
    clearTimeout(this.dismiss);
    const task = this.task;
    if (!task) { this.state.stage = 'idle'; this.state.overlayVisible = false; this.changed(); return; }
    this.task = undefined; clearInterval(this.clock); this.state.level = 0; this.state.stage = 'idle'; this.state.overlayVisible = false;
    if (task.action === 'selectionTranslation') { this.state.translation.loading = false; this.state.translation.error = '已取消翻译。'; }
    else if (task.manual) this.state.notice = '已停止整理，当前文稿已保留。';
    else if (task.original) { this.saveTask(task, task.original, false); this.state.notice = '已停止整理，识别原文已保留。'; }
    else this.state.notice = '已取消，本次临时录音已删除。';
    this.backend.setActive(false);
    this.cancelling = Promise.all([this.native.call('record.cancel').catch(() => {}), this.native.call('active', { value: false }).catch(() => {}), this.backend.cancel(task.id)]);
    this.changed(); await this.cancelling;
  }
  select(id: string) {
    if (busy(this.state.stage)) return;
    const item = this.state.library.manuscripts.find(value => value.id === id);
    if (item) { this.state.selectedID = id; this.state.draft = item.text; this.state.original = item.original; this.state.asrResults = structuredClone(item.asrResults || []); this.userEdited = item.userEdited === true; this.state.page = 'manuscripts'; this.changed(); }
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
  saveTerm(value: { id?: string; term: string; hint: string; aliases: string[] }) {
    if (busy(this.state.stage)) return;
    const term = value.term.trim(); if (!term) throw new Error('请填写词语。');
    const aliases = [...new Set(value.aliases.map(alias => alias.trim()).filter(alias => alias && alias !== term))];
    const others = this.state.library.lexicon.filter(item => item.id !== value.id);
    if (others.some(item => item.term.toLocaleLowerCase() === term.toLocaleLowerCase())) throw new Error('词库中已有这个词。');
    if (aliases.some(alias => others.some(item => item.term === alias || item.aliases?.includes(alias)))) throw new Error('这条误识别已属于另一个词条，请避免冲突。');
    const entry: Term = { id: value.id || randomUUID(), term, hint: value.hint.trim(), aliases };
    const index = this.state.library.lexicon.findIndex(item => item.id === entry.id);
    if (index < 0) this.state.library.lexicon.push(entry); else this.state.library.lexicon[index] = entry;
    this.persist(); this.changed();
  }
  removeTerm(id: string) { if (busy(this.state.stage)) return; this.state.library.lexicon = this.state.library.lexicon.filter(item => item.id !== id); this.persist(); this.changed(); }
  async shutdown() { clearTimeout(this.dismiss); clearInterval(this.clock); await this.cancel(); this.native.stop(); await this.backend.stop(); }
}
