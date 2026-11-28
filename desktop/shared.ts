export type Action = 'dictation' | 'voiceTranslation' | 'selectionTranslation';
export type Language = 'en' | 'zh-Hans' | 'ja' | 'de';
export type Stage = 'idle' | 'preparing' | 'recording' | 'transcribing' | 'polishing' | 'translating' | 'inserting' | 'success' | 'failure';
export type Page = 'desk' | 'manuscripts' | 'dictionary' | 'settings';
export const LLM_PURPOSES = { polish: '文本润色', hotword_extract: '热词提取', translate: '翻译' } as const;
export type LLMPurpose = keyof typeof LLM_PURPOSES;
export interface DailyAppUsage { appKey: string; name: string; sent: number; confirmed: number; unverified: number; icon?: string }
export interface DailyUsage {
  coverage: 'unrecorded' | 'partial' | 'recorded';
  sent: number;
  previousSent: number | null;
  apps: DailyAppUsage[];
  llm: { total: number | null; unknown: number; byPurpose: Record<LLMPurpose, number | null> };
}

const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export function characterCount(text: string) {
  let count = 0;
  for (const _ of graphemes.segment(text)) count++;
  return count;
}
export function localDayKey(date: Date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((value, index) => String(value).padStart(index ? 2 : 4, '0')).join('-');
}
export function localDayDate(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式无效。');
  const date = new Date(day + 'T00:00:00');
  if (localDayKey(date) !== day) throw new Error('日期无效。');
  return date;
}
export function shiftLocalDay(day: string, amount: number) {
  const date = localDayDate(day);
  date.setDate(date.getDate() + amount);
  return localDayKey(date);
}
export interface Shortcut { keyCode: number; modifiers: number; keyLabel: string; modifierKeys?: number[] }
export interface ASRResult { engine_name: string; transcript: string; language?: string | null; language_source?: 'detected' | 'forced' | 'unknown' }
export interface Manuscript { id: string; date: number; recordingEndedAtMs?: number; original: string; text: string; seconds: number; application: string; polished: boolean; deliveryNote?: string; asrResults?: ASRResult[]; userEdited?: boolean; hasAudio?: boolean; audioWarning?: string }
export interface ManuscriptAttachments {
  audio?: Uint8Array;
  screenshot?: Uint8Array;
}
export const TERM_GROUPS = { global: '全局', ai_tools: 'AI 工具', code_editor: '代码编辑器', messaging: '聊天', email: '邮件', document: '文档' } as const;
export type TermGroup = keyof typeof TERM_GROUPS;
export const isTermGroup = (value: unknown): value is TermGroup => typeof value === 'string' && Object.hasOwn(TERM_GROUPS, value);
export interface Term {
  id: string; term: string; hint: string; aliases?: string[];
  group?: TermGroup; matchCount?: number; lastMatchedAt?: number; createdAt?: number;
}
export interface Library { manuscripts: Manuscript[]; lexicon: Term[] }
export type Capability = 'asr' | 'text';
export type CapabilitySource = 'acpm' | 'online' | 'unavailable';
export interface OnlineEndpoint { enabled: boolean; baseURL: string; model: string }
export interface AcpmSettings {
  mode: 'local' | 'remote';
  remoteBaseURL: string;
  asrModel: string;
  textModel: string;
  vadEnabled: boolean;
}
export interface AcpmModelSummary {
  id: string;
  capability: string;
  displayName: string;
  installed: boolean;
  state: string;
  selectedVariant?: string | null;
}
export interface AcpmRuntimeInfo {
  connected: boolean;
  source: 'local' | 'remote';
  baseURL?: string;
  error?: string;
  models: AcpmModelSummary[];
  asrReady: boolean;
  textReady: boolean;
  vadReady: boolean;
}
export interface Settings {
  acpm: AcpmSettings; polishEnabled: boolean; style: string; readContext: boolean;
  keepHistory: boolean; saveRecordingScreenshot: boolean; syncAutoCacheBlobs: boolean; microphone: string; showDock: boolean; retention: number;
  // False only for a fresh install until the first-run guide is finished or skipped.
  onboarded: boolean;
  voiceTarget: Language; selectionTarget: Language; shortcuts: Record<Action, Shortcut[]>;
  // Opt-in OpenAI-compatible endpoints; API keys live encrypted in the main process, never here.
  online: Record<Capability, OnlineEndpoint>;
}
// Recording-start context/selection only. Insertion resolves current focus later.
export interface Destination { id?: string; name?: string; category?: string; before?: string; after?: string; secure?: boolean }
export interface NativeStatus { accessibility: boolean; eventTap: boolean; microphone: number; devices: { id: string; name: string }[] }
export interface Translation { source: string; result: string; language: Language; loading: boolean; error: string }
export type RuntimeStatus = 'checking' | 'acpm-disconnected' | 'models-pending' | 'asr-ready' | 'ready';
export interface RuntimeState { status: RuntimeStatus; issues: string[]; capabilities: { asr: CapabilitySource; text: CapabilitySource } }
export interface SyncHubSummary {
  hubInstanceId: string;
  hubName: string;
  serverPubkeyFp: string;
  lastKnownUrl?: string;
  manualRemoteUrl?: string;
  lastSeenAtMs?: number;
  lastPulledSeq?: number;
  lastSyncAtMs?: number;
}
export interface SyncStateSummary {
  enabled: boolean;
  vaultId?: string;
  deviceId: string;
  knownHubs: SyncHubSummary[];
  discoveredHubIds?: string[];
  spoofedHubIds?: string[];
  error?: string;
}
export interface AppState {
  update?: { version: string; busy: boolean; message: string };
  screenRecording?: boolean;
  learnedTerms?: string[];
  page: Page; stage: Stage; action: Action; settings: Settings; library: Library;
  selectedID: string | null; draft: string; original: string; liveTranscript?: string; liveProvisional?: string; notice: string;
  asrResults: ASRResult[];
  seconds: number; level: number; destinationName: string; checking: boolean; modelsChecked: boolean; overlayVisible: boolean;
  acpm: AcpmRuntimeInfo; acpmTokenSaved: boolean;
  sync?: SyncStateSummary;
  native: NativeStatus;
  translation: Translation; captureAction: Action | null; shortcutNotice: string; launchAtLogin: boolean;
  onlineKeys: Record<Capability, boolean>; runtime: RuntimeState; platform: 'mac' | 'windows';
}
export type TaskEvent = { event: 'stage' | 'transcript' | 'audio' | 'result' | 'error' | 'cancelled'; task_id: string; stage?: Stage; text?: string; original?: string; processed?: boolean; message?: string; asr_results?: ASRResult[]; audio_opus?: string; audio_warning?: string };
export const LANGUAGES: Record<Language, string> = { en: '英语', 'zh-Hans': '简体中文', ja: '日语', de: '德语' };
export const ACTIONS: Record<Action, string> = { dictation: '语音输入', voiceTranslation: '口述翻译', selectionTranslation: '划词翻译' };
export const STYLES = ['自然整理', '保留原话', '即时消息', '文档段落'];
// Carbon bits for ordinary modifiers; FN uses the macOS secondary-function bit
// and is handled by the event tap rather than Carbon hotkey registration.
export const FN_MODIFIER = 1 << 23;
export const MODIFIER_NAMES: Record<number, string> = { 63: 'FN', 59: '左 Control', 62: '右 Control', 56: '左 Shift', 60: '右 Shift', 58: '左 Option', 61: '右 Option', 55: '左 Command', 54: '右 Command' };
const MODIFIER_BITS: Record<number, number> = { 59: 4096, 62: 4096, 56: 512, 60: 512, 58: 2048, 61: 2048, 55: 256, 54: 256 };
export const defaultAcpmInfo = (mode: 'local' | 'remote' = 'local'): AcpmRuntimeInfo => ({
  connected: false, source: mode, models: [], asrReady: false, textReady: false, vadReady: false,
});
export const defaultSettings = (): Settings => ({
  acpm: { mode: 'local', remoteBaseURL: 'http://acpm.local:18790', asrModel: 'qwen3-asr-1.7b', textModel: 'yanmo-correct-4b-cot', vadEnabled: true },
  polishEnabled: true, style: '自然整理', readContext: false, keepHistory: true, saveRecordingScreenshot: false, syncAutoCacheBlobs: false, microphone: '', showDock: true, retention: 0, onboarded: true,
  voiceTarget: 'en', selectionTarget: 'en', shortcuts: {
    dictation: [{ keyCode: 63, modifiers: 0, keyLabel: 'FN' }],
    voiceTranslation: [{ keyCode: 63, modifiers: 512, keyLabel: 'FN' }],
    selectionTranslation: [{ keyCode: 49, modifiers: FN_MODIFIER, keyLabel: 'Space' }],
  },
  online: { asr: { enabled: false, baseURL: '', model: '' }, text: { enabled: false, baseURL: '', model: '' } },
});
export const CAPABILITIES: Record<Capability, string> = { asr: '语音识别', text: '文字整理与翻译' };
/** https only; plain http is allowed for a server on this Mac. Credentials or query strings in the URL are refused. */
export function checkOnlineURL(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('在线服务地址无效。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('在线服务地址需使用 https；本机服务可用 http。');
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不要包含账号、密钥或参数。');
}
function isPrivateIPv4(hostname: string) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
/** Validates remote AcpmRuntime URLs: https anywhere, or http on loopback / .local mDNS / private LAN IPv4. */
export function checkAcpmURL(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('AcpmRuntime 服务地址无效。'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不要包含账号、密钥或参数。');
  const host = url.hostname.toLowerCase();
  const allowedHttp = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.endsWith('.local') || isPrivateIPv4(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowedHttp)) {
    throw new Error('远程 AcpmRuntime 服务需使用 https，或局域网 / mDNS (.local) / 本机 http 地址。');
  }
}
export const busy = (stage: Stage) => !['idle', 'success', 'failure'].includes(stage);
export const cocoaNow = () => Date.now() / 1000 - 978307200;
export const manuscriptDate = (date: number) => new Date((date + 978307200) * 1000);
export function shortcutID(key: Shortcut) {
  if (key.modifierKeys?.includes(63)) return '63:' + key.modifierKeys.reduce((bits, code) => bits | (MODIFIER_BITS[code] ?? 0), 0);
  return key.modifierKeys ? 'mod:' + [...key.modifierKeys].sort((a, b) => a - b).join('+') : key.keyCode + ':' + key.modifiers;
}
export function shortcutNeedsEventTap(key: Shortcut) { return key.keyCode === 63 || !!key.modifierKeys || !!(key.modifiers & FN_MODIFIER) || (key.keyCode === 49 && key.modifiers === 4096); }
export function shortcutLabel(key: Shortcut) {
  if (key.modifierKeys?.includes(63)) return shortcutLabel({ keyCode: 63, modifiers: key.modifierKeys.reduce((bits, code) => bits | (MODIFIER_BITS[code] ?? 0), 0), keyLabel: 'FN' });
  if (key.modifierKeys) return [...key.modifierKeys].sort((a, b) => a - b).map(code => MODIFIER_NAMES[code]).join(' + ');
  return [key.keyCode === 63 || (key.modifiers & FN_MODIFIER) ? 'FN' : '',
    key.modifiers & 4096 ? 'Control' : '', key.modifiers & 2048 ? 'Option' : '',
    key.modifiers & 256 ? 'Command' : '', key.modifiers & 512 ? 'Shift' : '',
    key.keyCode === 63 ? '' : key.keyCode === 49 ? '空格' : key.keyLabel].filter(Boolean).join(' + ');
}
export function validateSettings(settings: Settings) {
  if (!settings || typeof settings !== 'object') throw new Error('设置无效。');
  if (typeof settings.microphone !== 'string' || settings.microphone.length > 2000) throw new Error('模型或设备配置无效。');
  for (const name of ['polishEnabled', 'readContext', 'keepHistory', 'saveRecordingScreenshot', 'syncAutoCacheBlobs', 'showDock', 'onboarded'] as const) if (typeof settings[name] !== 'boolean') throw new Error('设置值无效。');
  if (!STYLES.includes(settings.style) || ![0, 1, 7, 30, 365].includes(settings.retention)) throw new Error('整理风格或保留时间无效。');
  const acpm = settings.acpm;
  if (!acpm || typeof acpm !== 'object' || !['local', 'remote'].includes(acpm.mode)
    || typeof acpm.remoteBaseURL !== 'string' || acpm.remoteBaseURL.length > 500
    || typeof acpm.asrModel !== 'string' || !acpm.asrModel.trim() || acpm.asrModel.length > 200
    || typeof acpm.textModel !== 'string' || !acpm.textModel.trim() || acpm.textModel.length > 200
    || typeof acpm.vadEnabled !== 'boolean') {
    throw new Error('AcpmRuntime 配置无效。');
  }
  if (acpm.remoteBaseURL.trim()) checkAcpmURL(acpm.remoteBaseURL.trim());
  if (acpm.mode === 'remote' && !acpm.remoteBaseURL.trim()) throw new Error('启用远程 AcpmRuntime 前，请填写服务地址。');
  for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
    const value = settings.online?.[capability];
    if (!value || typeof value.enabled !== 'boolean' || typeof value.baseURL !== 'string' || typeof value.model !== 'string' || value.baseURL.length > 500 || value.model.length > 200) throw new Error('在线模型配置无效。');
    if (value.baseURL) checkOnlineURL(value.baseURL);
    if (value.enabled && (!value.baseURL || !value.model.trim())) throw new Error('启用在线' + CAPABILITIES[capability] + '前，请填写服务地址和模型 ID。');
  }
  if (!Object.hasOwn(LANGUAGES, settings.voiceTarget) || !Object.hasOwn(LANGUAGES, settings.selectionTarget)) throw new Error('目标语言无效。');
  const seen = new Set<string>();
  for (const action of Object.keys(ACTIONS) as Action[]) {
    const keys = settings.shortcuts?.[action];
    if (!Array.isArray(keys) || keys.length > 20 || (action === 'dictation' && !keys.length)) throw new Error('请至少保留一组语音输入快捷键。');
    for (const key of keys) {
      if (!Number.isInteger(key.keyCode) || key.keyCode < 0 || key.keyCode > 127 || !Number.isInteger(key.modifiers) || (key.modifiers & ~(6912 | FN_MODIFIER)) || typeof key.keyLabel !== 'string' || key.keyLabel.length > 80 || (key.keyCode === 63 && (key.modifiers & FN_MODIFIER))) throw new Error('快捷键配置无效。');
      if (key.modifierKeys) {
        if (!key.modifierKeys.length || new Set(key.modifierKeys).size !== key.modifierKeys.length || key.modifierKeys.some(code => !(code in MODIFIER_NAMES))) throw new Error('请选择有效的修饰键。');
      } else if (key.keyCode !== 63) {
        if (!(key.modifiers & (256 | 4096 | FN_MODIFIER))) throw new Error('请搭配 FN、Control 或 Command，避免影响正常打字。');
        if ([36, 48, 51, 53, 63, 117].includes(key.keyCode)) throw new Error('请选一个字母、数字、空格或功能键。');
        if (key.modifiers === 256 && [0, 4, 6, 7, 8, 9, 12, 13, 46, 49].includes(key.keyCode)) throw new Error('这是常用系统或编辑快捷键，请换一组组合。');
      }
      const id = shortcutID(key);
      if (seen.has(id)) throw new Error('这组快捷键已被使用，请选择不同的快捷键。');
      seen.add(id);
    }
  }
}
export function migrateSettings(legacy: Record<string, unknown>): Settings {
  const settings = defaultSettings();
  if (typeof legacy.asr === 'string' && legacy.asr.toLowerCase().includes('0.6b')) {
    settings.acpm.asrModel = 'qwen3-asr-0.6b';
  }
  const map = { polish: 'polishEnabled', context: 'readContext', history: 'keepHistory', microphone: 'microphone', showDock: 'showDock', retention: 'retention', style: 'style', voiceTarget: 'voiceTarget', selectionTarget: 'selectionTarget' } as const;
  for (const [old, name] of Object.entries(map)) if (legacy[old] !== undefined) (settings as unknown as Record<string, unknown>)[name] = legacy[old];
  const used = new Set<string>();
  for (const [action, key] of Object.entries({ dictation: 'shortcuts', voiceTranslation: 'voiceTranslationShortcuts', selectionTranslation: 'selectionTranslationShortcuts' }) as [Action, string][]) {
    const values = legacy[key] as Shortcut[] | undefined;
    settings.shortcuts[action] = (values ?? settings.shortcuts[action]).filter(value => {
      const id = shortcutID(value); if (used.has(id)) return false; used.add(id); return true;
    });
  }
  validateSettings(settings);
  return settings;
}
export interface DesktopAPI {
  state(): Promise<AppState>;
  dailyUsage(day: string): Promise<DailyUsage>;
  manuscriptAttachments(id: string): Promise<ManuscriptAttachments>;
  invoke(action: string, args?: unknown): Promise<unknown>;
  subscribe(listener: (state: AppState) => void): () => void;
}
declare global { interface Window { yanmo: DesktopAPI } }
