import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, shell, systemPreferences, Tray } from 'electron';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { Controller } from './controller';
import { NativeBridge } from './processes';
import { InferenceService } from './inference';
import { LibraryStore } from './store';
import { SyncEngine } from './sync-engine';
import { FileKnownHubStore, SyncPairingService, type SyncSecretsRecord, type SyncSecretStore } from './sync-pairing';
import type { SyncPlatform } from './sync-crypto';
import { findUpdate, installOnExit, stageUpdate, UpdateError } from './updates';
import { AcpmSettings, ACTIONS, Action, AppState, busy, Capability, CAPABILITIES, checkAcpmURL, cocoaNow, defaultSettings, migrateSettings, Page, Settings } from './shared';

let mainWindow: BrowserWindow;
let overlay: BrowserWindow;
let translation: BrowserWindow;
let tray: Tray;
let trayMenu: Menu | undefined;
let controller: Controller;
let syncPairing: SyncPairingService;
let syncEngine: SyncEngine;
let quitting = false;
let initialized = false;
let trayState = '';
const root = app.isPackaged ? process.resourcesPath : resolve(__dirname, '..');
const index = app.isPackaged ? join(app.getAppPath(), 'web/index.html') : join(root, 'web/index.html');
const indexURL = pathToFileURL(index).href;
const preload = join(__dirname, 'preload.cjs');
// Leave room for the upward entrance; the visible pill still rests 30px above the work area bottom.
const overlaySize = { width: 220, height: 80, bottom: 8 };
const dataDirectory = process.env.YANMO_DATA_DIR || join(app.getPath('appData'), 'Yanmo', 'electron');
app.setName('言墨');
app.setPath('userData', dataDirectory);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => reveal());

function updateDock(visible: boolean) {
  app.setActivationPolicy(controller.state.settings.showDock && visible ? 'regular' : 'accessory');
}
function reveal() {
  if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
  // Restore the normal activation policy before focusing a window from the tray.
  updateDock(true);
  mainWindow.show(); mainWindow.focus();
}
function external(url: string) {
  try { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url); } catch { /* Invalid links stay inert. */ }
}
function secureWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(indexURL)) { event.preventDefault(); external(url); } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}
async function createWindows() {
  const common = { webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } };
  mainWindow = new BrowserWindow({ ...common, width: 1120, height: 800, minWidth: 980, minHeight: 720, title: '言墨', titleBarStyle: 'hidden', trafficLightPosition: { x: 17, y: 16 }, backgroundColor: '#f6f3ec', show: false });
  overlay = new BrowserWindow({ ...common, width: overlaySize.width, height: overlaySize.height, frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, hasShadow: false, show: false, type: 'panel' });
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  overlay.setAlwaysOnTop(true, 'floating');
  translation = new BrowserWindow({ ...common, width: 740, height: 650, minWidth: 520, minHeight: 400, title: '言墨 · 划词翻译', titleBarStyle: 'hidden', trafficLightPosition: { x: 17, y: 16 }, backgroundColor: '#f6f3ec', show: false });
  for (const window of [mainWindow, overlay, translation]) secureWindow(window);
  mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); if (controller?.state.captureAction) void controller.endCapture(); mainWindow.hide(); } });
  mainWindow.on('hide', () => { if (!quitting) updateDock(false); });
  mainWindow.on('focus', () => {
    refreshScreenRecordingAccess();
    if (controller && !busy(controller.state.stage) && !controller.state.checking && !controller.state.acpm.connected) {
      void controller.checkModels();
    }
  });
  translation.on('close', event => { if (!quitting) { event.preventDefault(); translation.hide(); void controller?.closeTranslation(); } });
  await Promise.all([mainWindow.loadFile(index), overlay.loadFile(index, { query: { view: 'overlay' } }), translation.loadFile(index, { query: { view: 'translation' } })]);
  reveal();
}
let overlayHide: NodeJS.Timeout | undefined;
function showOverlay() {
  if (quitting || overlay.isDestroyed()) return;
  clearTimeout(overlayHide); overlayHide = undefined;
  const hasPreview = Boolean((controller.state.liveTranscript || controller.state.liveProvisional) && busy(controller.state.stage));
  const width = controller.state.learnedTerms?.length ? 440 : hasPreview ? 380 : overlaySize.width;
  const height = hasPreview && !controller.state.learnedTerms?.length ? 116 : overlaySize.height;
  const [curW, curH] = overlay.getSize();
  const resized = curW !== width || curH !== height;
  if (resized) overlay.setSize(width, height);
  if (!overlay.isVisible() || resized) {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    overlay.setPosition(Math.round(workArea.x + (workArea.width - width) / 2), workArea.y + workArea.height - height - overlaySize.bottom);
    overlay.showInactive();
  }
}
function refreshScreenRecordingAccess() {
  if (process.platform !== 'darwin' || !controller || quitting) return;
  const granted = systemPreferences.getMediaAccessStatus('screen') === 'granted';
  if (controller.state.screenRecording !== granted) {
    controller.state.screenRecording = granted;
    controller.changed();
  }
}
async function captureRecordingScreenshot(): Promise<Buffer | undefined> {
  refreshScreenRecordingAccess();
  if (process.platform === 'darwin' && !controller.state.screenRecording) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = display.size;
  const scale = Math.min(display.scaleFactor, 1920 / Math.max(width, height));
  const alignment = process.platform === 'darwin' ? 2 : 1;
  const fit = (length: number) => Math.max(alignment, Math.round(length * scale / alignment) * alignment);
  const thumbnailSize = { width: fit(width), height: fit(height) };
  const timeout = new AbortController();
  try {
    const sources = await Promise.race([
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize }),
      wait(1200, undefined, { signal: timeout.signal }),
    ]);
    const source = sources?.find(item => item.display_id === String(display.id))
      ?? (sources?.length === 1 && !sources[0].display_id && screen.getAllDisplays().length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) return;
    const thumbnail = source.thumbnail;
    if (process.platform === 'darwin') {
      try {
        const result = await Promise.race([
          controller.native.call<{ avif?: string }>('screenshot.encode', { png: thumbnail.toPNG().toString('base64') }),
          wait(3000, undefined, { signal: timeout.signal }),
        ]);
        if (result?.avif) return Buffer.from(result.avif, 'base64');
      } catch { /* Older macOS versions may not offer an AVIF encoder. */ }
    }
    return thumbnail.toJPEG(54);
  } finally { timeout.abort(); }
}
// Let the renderer's short fade finish before the panel disappears.
function hideOverlay() {
  if (overlayHide || !overlay.isVisible()) return;
  overlayHide = setTimeout(() => { overlayHide = undefined; if (!overlay.isDestroyed()) overlay.hide(); }, 170);
}
function broadcast(state: AppState) {
  if (quitting) return;
  for (const window of [mainWindow, overlay, translation]) if (window && !window.isDestroyed()) window.webContents.send('yanmo:state', state);
  if (overlay && !overlay.isDestroyed()) { if (state.learnedTerms?.length || (state.overlayVisible && state.stage !== 'idle')) showOverlay(); else hideOverlay(); }
  if (initialized) updateTray();
}
function updateTray() {
  if (quitting || !tray || tray.isDestroyed()) return;
  const state = controller.state;
  const { asr, text } = state.runtime.capabilities;
  const key = [state.stage, state.settings.voiceTarget, asr, text, state.acpm.connected].join(':');
  if (key === trayState) return;
  trayState = key;
  const statusLabel = asr === 'unavailable'
    ? 'AcpmRuntime 未就绪'
    : text === 'online'
      ? '文字处理使用在线 API'
      : text === 'acpm'
        ? 'AcpmRuntime 本地就绪'
        : '语音识别就绪（文字待配置）';
  trayMenu = Menu.buildFromTemplate([
    { label: state.stage === 'recording' ? '结束录音' : '开始录音', enabled: !busy(state.stage) || state.stage === 'recording', click: () => void controller.perform('dictation') },
    { label: '口述翻译', enabled: !busy(state.stage) || state.stage === 'recording', click: () => void controller.perform('voiceTranslation') },
    { label: '取消', enabled: busy(state.stage), click: () => void controller.cancel() },
    { type: 'separator' }, { label: '打开言墨', click: reveal },
    { label: '设置…', click: () => { controller.setPage('settings'); reveal(); } },
    ...(state.update ? [{ label: '检查更新…', click: showUpdates }] : []),
    { type: 'separator' }, { label: statusLabel, enabled: false }, { label: '退出言墨', click: () => app.quit() },
  ]);
}
async function importAudio() {
  if (busy(controller.state.stage)) return;
  const result = await dialog.showOpenDialog(mainWindow, { title: '导入音频', properties: ['openFile'], filters: [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'aiff', 'aif', 'flac', 'ogg', 'aac', 'mp4'] }] });
  if (!result.canceled && result.filePaths[0]) await controller.importAudio(result.filePaths[0]);
}
const appBundle = () => resolve(process.execPath, '../../..');
function showUpdates() {
  controller.setPage('settings'); reveal();
  void checkUpdates();
}
async function checkUpdates() {
  const status = controller.state.update;
  if (!status || status.busy || quitting) return;
  const report = (message: string) => { status.message = message; controller.changed(); };
  status.busy = true;
  report('正在检查更新…');
  let staged: Awaited<ReturnType<typeof stageUpdate>> | undefined;
  let scheduled = false;
  try {
    const update = await findUpdate(status.version, fetch);
    if (!update) { report('当前已是最新版本。'); return; }
    const confirm = await dialog.showMessageBox(mainWindow, {
      type: 'info', title: '言墨更新', message: '言墨 ' + update.version + ' 可用',
      detail: '下载约 ' + Math.ceil(update.size / 1024 ** 2) + ' MB。下载完成后可立即重启安装。macOS 可能要求重新授予辅助功能或钥匙串访问权限。',
      buttons: ['下载更新', '稍后'], defaultId: 0, cancelId: 1,
    });
    if (confirm.response !== 0) { report('可更新至 ' + update.version + '。'); return; }
    staged = await stageUpdate(appBundle(), join(root, 'install-mac-update.sh'), update, fetch, percent => {
      report(percent === 100 ? '正在验证安装包…' : '正在下载更新 · ' + percent + '%');
    });
    const install = await dialog.showMessageBox(mainWindow, {
      type: 'info', title: '言墨更新', message: '已下载言墨 ' + update.version,
      buttons: ['安装并重启', '稍后'], defaultId: 0, cancelId: 1,
    });
    if (install.response !== 0) { report('已取消安装。'); return; }
    if (busy(controller.state.stage) || controller.state.checking) throw new UpdateError('请等当前任务完成，再安装更新。');
    await installOnExit(appBundle(), staged);
    scheduled = true;
    app.quit();
  } catch (error) {
    report(error instanceof UpdateError ? error.message : '更新未完成，请检查网络和应用目录后重试。');
  } finally {
    if (staged && !scheduled) await rm(staged.staging, { recursive: true, force: true }).catch(() => {});
    status.busy = false;
    controller.changed();
  }
}
// Secrets are encrypted with safeStorage, whose key lives in the macOS Keychain; the file alone cannot be read elsewhere.
type SecretKey = Capability | 'acpm';
const SECRET_KEYS = new Set<string>(['asr', 'text', 'acpm']);
const keysPath = () => join(dataDirectory, 'online-keys.json');
function readStoredKeys(): Partial<Record<SecretKey, string>> {
  if (!existsSync(keysPath())) return {};
  try {
    const stored = JSON.parse(readFileSync(keysPath(), 'utf8')) as Record<string, string>;
    return Object.fromEntries(Object.entries(stored).filter(([name, value]) => SECRET_KEYS.has(name) && typeof value === 'string')
      .map(([name, value]) => [name, safeStorage.decryptString(Buffer.from(value, 'base64'))])) as Partial<Record<SecretKey, string>>;
  } catch { return {}; }
}
function writeStoredKeys(keys: Partial<Record<SecretKey, string>>) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('无法使用钥匙串加密，密钥未保存。');
  const entries = Object.entries(keys).filter(([, value]) => value);
  if (!entries.length) { rmSync(keysPath(), { force: true }); return; }
  writeFileSync(keysPath(), JSON.stringify(Object.fromEntries(entries.map(([name, value]) => [name, safeStorage.encryptString(value!).toString('base64')]))), { mode: 0o600 });
}
function onlineKeysFrom(keys: Partial<Record<SecretKey, string>>): Partial<Record<Capability, string>> {
  return { ...(keys.asr ? { asr: keys.asr } : {}), ...(keys.text ? { text: keys.text } : {}) };
}
const syncIdentityPath = () => join(dataDirectory, 'sync-identity.json');
const safeStorageSyncSecretStore: SyncSecretStore = {
  load(): SyncSecretsRecord | null {
    const filePath = syncIdentityPath();
    if (!existsSync(filePath)) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('无法使用钥匙串解密同步身份密钥。');
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { encrypted?: string };
    if (typeof raw?.encrypted !== 'string' || !raw.encrypted) {
      throw new Error('同步身份密钥文件已损坏（缺少密文）。');
    }
    const decoded = JSON.parse(safeStorage.decryptString(Buffer.from(raw.encrypted, 'base64'))) as SyncSecretsRecord;
    if (!decoded || typeof decoded.deviceId !== 'string' || !decoded.deviceId || typeof decoded.devicePrivateSeedB64 !== 'string' || !decoded.devicePrivateSeedB64) {
      throw new Error('同步身份密钥内容无效。');
    }
    return decoded;
  },
  save(record: SyncSecretsRecord) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('无法使用钥匙串加密，同步密钥未保存。');
    const encrypted = safeStorage.encryptString(JSON.stringify(record)).toString('base64');
    const filePath = syncIdentityPath();
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ version: 1, encrypted }), { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
  },
};
const syncPlatform = (): SyncPlatform => (process.platform === 'win32' ? 'windows' : 'macos');
const syncDeviceName = () => hostname() || (process.platform === 'win32' ? '言墨 Windows' : '言墨 Mac');
let lastDiscoveredHubIds: string[] = [];
let lastSpoofedHubIds: string[] = [];
let syncDebounceTimer: NodeJS.Timeout | undefined;
let syncPeriodicTimer: NodeJS.Timeout | undefined;
function scheduleBackgroundSync(delayMs = 3000) {
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = undefined;
  }
  if (quitting || !controller || controller.store.error || !syncPairing || !syncEngine) return;
  syncDebounceTimer = setTimeout(() => {
    syncDebounceTimer = undefined;
    if (quitting || !controller || controller.store.error || !syncPairing || !syncEngine) return;
    let enabled = false;
    try {
      enabled = syncPairing.getStatus().enabled;
    } catch {
      return;
    }
    if (!enabled) return;
    void syncEngine.syncAllKnownHubs(undefined, { uploadBlobs: controller.state.settings.syncAutoCacheBlobs })
      .then(() => { refreshSyncState(); })
      .catch(() => { /* Background sync stays quiet when hubs are offline. */ });
  }, Math.max(0, delayMs));
}
function refreshSyncState() {
  if (!controller || !syncPairing) return;
  try {
    const status = syncPairing.getStatus();
    if (!controller.store.error) {
      const cursors = new Map(controller.store.listHubCursors().map(c => [c.hubInstanceId, c]));
      status.knownHubs = status.knownHubs.map(hub => {
        const cursor = cursors.get(hub.hubInstanceId);
        return cursor
          ? { ...hub, lastPulledSeq: cursor.lastPulledSeq, lastSyncAtMs: cursor.lastSyncAtMs ?? hub.lastSeenAtMs }
          : hub;
      });
    }
    status.discoveredHubIds = [...lastDiscoveredHubIds];
    status.spoofedHubIds = [...lastSpoofedHubIds];
    controller.state.sync = status;
    controller.changed();
  } catch (error) {
    controller.state.sync = {
      enabled: false,
      deviceId: '',
      knownHubs: [],
      error: (error as Error).message,
    };
    controller.changed();
  }
}
async function saveOnline(value: any) {
  if (!value || !Object.hasOwn(CAPABILITIES, value.capability) || typeof value.enabled !== 'boolean' || typeof value.baseURL !== 'string' || typeof value.model !== 'string' || (value.key !== undefined && (typeof value.key !== 'string' || value.key.length > 1000))) throw new Error('在线模型配置无效。');
  const capability = value.capability as Capability;
  if (value.key?.trim()) {
    const keys = { ...readStoredKeys(), [capability]: value.key.trim() };
    writeStoredKeys(keys);
    controller.setOnlineKeys(onlineKeysFrom(keys));
  }
  await controller.updateSettings({ online: { ...controller.state.settings.online, [capability]: { enabled: value.enabled, baseURL: value.baseURL.trim(), model: value.model.trim() } } });
  controller.notice(value.enabled ? CAPABILITIES[capability] + '将使用 API 模型 ' + value.model.trim() + '。' : (capability === 'asr' ? '语音识别使用 AcpmRuntime。' : '已改回 AcpmRuntime 文字处理。'));
}
async function saveAcpm(value: any) {
  if (!value || typeof value !== 'object' || !['local', 'remote'].includes(value.mode) || typeof value.remoteBaseURL !== 'string' || typeof value.asrModel !== 'string' || typeof value.textModel !== 'string' || typeof value.vadEnabled !== 'boolean' || (value.token !== undefined && (typeof value.token !== 'string' || value.token.length > 1000))) {
    throw new Error('AcpmRuntime 连接配置无效。');
  }
  const nextAcpm: AcpmSettings = {
    mode: value.mode,
    remoteBaseURL: value.remoteBaseURL.trim(),
    asrModel: value.asrModel.trim(),
    textModel: value.textModel.trim(),
    vadEnabled: value.vadEnabled,
  };
  if (nextAcpm.remoteBaseURL) checkAcpmURL(nextAcpm.remoteBaseURL);
  if (value.token?.trim()) {
    const keys = { ...readStoredKeys(), acpm: value.token.trim() };
    writeStoredKeys(keys);
    controller.setAcpmToken(value.token.trim());
  }
  await controller.updateSettings({ acpm: nextAcpm });
  controller.notice(nextAcpm.mode === 'remote' ? '已保存远程 AcpmRuntime 连接配置。' : '已切换为本机 AcpmRuntime 自动发现。');
}
async function invoke(action: string, value: any, sender?: Electron.WebContents) {
  if (!controller || quitting) throw new Error('请等待言墨启动或退出完成。');
  if (action.startsWith('sync') && sender !== mainWindow?.webContents) {
    throw new Error('同步设置操作仅限在主窗口中执行。');
  }
  const sanitizeDeviceName = (raw: unknown) => {
    if (typeof raw !== 'string') return syncDeviceName();
    const clean = raw.trim();
    if (!clean) return syncDeviceName();
    if (clean.length > 100) throw new Error('设备名称过长。');
    return clean;
  };
  const sanitizeScopes = (raw: unknown): ('inference' | 'yanmo.sync')[] | undefined => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some(s => s !== 'inference' && s !== 'yanmo.sync')) {
      throw new Error('设备权限配置无效。');
    }
    return [...new Set(raw)] as ('inference' | 'yanmo.sync')[];
  };
  const sanitizeAdvertiseAddrs = (raw: unknown): string[] | undefined => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.length > 16 || raw.some(a => typeof a !== 'string' || !a.trim() || a.length > 256)) {
      throw new Error('广播地址列表无效。');
    }
    return raw.map(a => a.trim());
  };
  const confirmReplaceSpaceIfEnabled = async (): Promise<boolean> => {
    if (!syncPairing.getStatus().enabled) return false;
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: '当前已加入个人同步空间。若目标空间不同，将继续并重置本机同步进度；是否继续？',
      buttons: ['取消', '确认切换'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice.response !== 1) throw new Error('已取消切换同步空间。');
    return true;
  };
  switch (action) {
    case 'page': controller.setPage(value as Page); break;
    case 'clearNotice': controller.notice(''); break;
    case 'record': if (Object.hasOwn(ACTIONS, value)) await controller.perform(value as Action); break;
    case 'finish': await controller.finishRecording(); break;
    case 'cancel': await controller.cancel(); break;
    case 'import': await importAudio(); break;
    case 'check': await controller.checkModels(); break;
    case 'checkUpdates': await checkUpdates(); break;
    case 'acpmSave': await saveAcpm(value); break;
    case 'acpmTokenClear': {
      const keys = readStoredKeys();
      delete keys.acpm;
      writeStoredKeys(keys);
      controller.setAcpmToken('');
      if (controller.state.settings.acpm.mode === 'remote') await controller.checkModels();
      controller.notice('已删除 AcpmRuntime Token。');
      break;
    }
    case 'permissions':
    case 'screenRecordingGuide': {
      if (action === 'screenRecordingGuide' && !canRequestScreenRecording()) break;
      // The guide panel flies from the clicked button; renderer rects are relative to the window content.
      const bounds = mainWindow.getContentBounds();
      const source = value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) ? { x: bounds.x + value.x, y: bounds.y + value.y, width: value.width, height: value.height } : undefined;
      const guide = { app: appBundle(), source };
      if (action === 'permissions') await controller.permissions(true, guide);
      else await controller.native.call('screenRecording.guide', guide);
      break;
    }
    case 'settings': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置值无效。');
      if ('retention' in value && value.retention && controller.state.library.manuscripts.some(item => item.date < cocoaNow() - value.retention * 86400)) {
        const choice = await dialog.showMessageBox(mainWindow, { type: 'warning', message: '超期文稿及其录音和截屏将从本机永久删除。', buttons: ['取消', '更改并删除超期文稿'], defaultId: 0, cancelId: 0 });
        if (choice.response !== 1) return;
      }
      await controller.updateSettings(value);
      if ('keepHistory' in value || 'saveRecordingScreenshot' in value) refreshScreenRecordingAccess();
      break;
    }
    case 'screenRecordingRequest': {
      if (!canRequestScreenRecording()) break;
      refreshScreenRecordingAccess();
      if (controller.state.screenRecording) break;
      await controller.native.call('screenRecording.request');
      refreshScreenRecordingAccess();
      break;
    }
    case 'capture': await controller.beginCapture(value); break;
    case 'captureEnd': await controller.endCapture(); break;
    case 'captureSave': await controller.saveCaptured(value); break;
    case 'shortcutRemove': if (value && Object.hasOwn(ACTIONS, value.action) && typeof value.id === 'string') await controller.removeShortcut(value.action, value.id); break;
    case 'shortcutReset': if (Object.hasOwn(ACTIONS, value)) await controller.resetShortcut(value as Action); break;
    case 'select': if (typeof value === 'string') controller.select(value); break;
    case 'draft': if (value && typeof value.text === 'string') controller.updateDraft(value.id, value.text); break;
    case 'deleteManuscript': {
      if (typeof value !== 'string' || busy(controller.state.stage)) return;
      const choice = await dialog.showMessageBox(mainWindow, { type: 'warning', message: '删除这份文稿及其录音和截屏？此操作无法撤销。', buttons: ['取消', '删除文稿'], defaultId: 0, cancelId: 0 });
      if (choice.response === 1) controller.deleteManuscript(value); break;
    }
    case 'termSave': if (value && typeof value.term === 'string' && typeof value.hint === 'string' && Array.isArray(value.aliases) && value.aliases.every((alias: unknown) => typeof alias === 'string')) controller.saveTerm(value); else throw new Error('词条格式无效。'); break;
    case 'undoLearnedTerms': controller.undoLearnedTerms(); break;
    case 'termRemove': if (typeof value === 'string') controller.removeTerm(value); break;
    case 'polish': await controller.polishDraft(); break;
    case 'copyDraft': clipboard.writeText(controller.state.draft); controller.notice('正文已复制。'); break;
    case 'copyText': if (typeof value === 'string') clipboard.writeText(value); break;
    case 'export': {
      const result = await dialog.showSaveDialog(mainWindow, { title: '导出文稿', defaultPath: '言墨文稿.txt', filters: [{ name: '纯文本', extensions: ['txt'] }] });
      if (!result.canceled && result.filePath) { await writeFile(result.filePath, controller.state.draft, { encoding: 'utf8', mode: 0o600 }); controller.notice('文稿已导出。'); } break;
    }
    case 'translationRetry': await controller.retryTranslation(value); break;
    case 'translationClose': translation.hide(); await controller.closeTranslation(); break;
    case 'revealDraft': controller.setPage('manuscripts'); reveal(); break;
    case 'online': await saveOnline(value); break;
    case 'onlineKeyClear': {
      if (!Object.hasOwn(CAPABILITIES, value)) throw new Error('在线模型配置无效。');
      const keys = readStoredKeys(); delete keys[value as Capability]; writeStoredKeys(keys); controller.setOnlineKeys(onlineKeysFrom(keys)); controller.notice('已删除' + CAPABILITIES[value as Capability] + '的 API Key。'); break;
    }
    case 'login': app.setLoginItemSettings({ openAtLogin: value === true }); controller.state.launchAtLogin = app.getLoginItemSettings().openAtLogin; controller.changed(); break;
    case 'syncStatus': {
      refreshSyncState();
      return controller.state.sync;
    }
    case 'syncEnableLocal': {
      const status = await syncPairing.enableOnLocalHub(sanitizeDeviceName(value?.deviceName), syncPlatform());
      syncEngine.ensureConfigured();
      refreshSyncState();
      return controller.state.sync ?? status;
    }
    case 'syncCreateInvite': {
      const scopes = sanitizeScopes(value?.scopes);
      const advertiseAddrs = sanitizeAdvertiseAddrs(value?.advertiseAddrs);
      const hubId = typeof value?.hubId === 'string' && value.hubId.trim() ? value.hubId.trim() : undefined;
      return await syncPairing.createInvitePairing({ scopes, hubId, advertiseAddrs });
    }
    case 'syncRedeemInvite': {
      if (typeof value?.qr !== 'string' || !value.qr.trim()) throw new Error('请提供邀请配对二维码内容。');
      const allowReplaceSpace = await confirmReplaceSpaceIfEnabled();
      const status = await syncPairing.redeemInvitePairing(value.qr, sanitizeDeviceName(value?.deviceName), syncPlatform(), { allowReplaceSpace });
      syncEngine.ensureConfigured();
      refreshSyncState();
      return controller.state.sync ?? status;
    }
    case 'syncCreateJoinWait': {
      const advertiseAddrs = sanitizeAdvertiseAddrs(value?.advertiseAddrs);
      return await syncPairing.createJoinWaitPairing({ advertiseAddrs });
    }
    case 'syncCompleteJoinWait': {
      if (typeof value?.sessionId !== 'string' || !value.sessionId.trim()) throw new Error('缺少配对会话 ID。');
      const allowReplaceSpace = await confirmReplaceSpaceIfEnabled();
      const status = await syncPairing.completeJoinWaitOnNewDevice(value.sessionId.trim(), sanitizeDeviceName(value?.deviceName), syncPlatform(), { allowReplaceSpace });
      syncEngine.ensureConfigured();
      refreshSyncState();
      return controller.state.sync ?? status;
    }
    case 'syncExportRecoveryCode': {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: '恢复码可完全访问并解密您的个人同步空间，请妥善保管并勿发送给他人。确认查看恢复码？',
        buttons: ['取消', '显示恢复码'],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice.response !== 1) throw new Error('已取消导出恢复码。');
      return { recoveryCode: syncPairing.exportRecoveryCode() };
    }
    case 'syncRestoreRecoveryCode': {
      if (typeof value?.code !== 'string' || !value.code.trim()) throw new Error('请输入恢复码。');
      const allowReplaceSpace = await confirmReplaceSpaceIfEnabled();
      const status = await syncPairing.restoreFromRecoveryCode(value.code, sanitizeDeviceName(value?.deviceName), syncPlatform(), {
        registerLocal: value?.registerLocal !== false,
        allowReplaceSpace,
      });
      syncEngine.ensureConfigured();
      refreshSyncState();
      return controller.state.sync ?? status;
    }
    case 'syncDiscoverHubs': {
      const rawTimeout = typeof value?.timeoutMs === 'number' && Number.isFinite(value.timeoutMs)
        ? Math.min(15_000, Math.max(500, Math.floor(value.timeoutMs)))
        : undefined;
      const result = await syncPairing.discoverKnownHubs(rawTimeout);
      lastDiscoveredHubIds = result.matched.map(m => m.hubInstanceId);
      lastSpoofedHubIds = [...result.spoofedHubIds];
      refreshSyncState();
      return result;
    }
    case 'syncNow': {
      const uploadBlobs = typeof value?.uploadBlobs === 'boolean'
        ? value.uploadBlobs
        : controller.state.settings.syncAutoCacheBlobs;
      const result = typeof value?.hubId === 'string' && value.hubId.trim()
        ? await syncEngine.syncWithHub(value.hubId.trim(), undefined, { uploadBlobs })
        : await syncEngine.syncAllKnownHubs(undefined, { uploadBlobs });
      refreshSyncState();
      return result;
    }
    case 'syncUploadBlobs': {
      if (typeof value?.manuscriptId !== 'string' || !value.manuscriptId.trim()) throw new Error('缺少文稿 ID。');
      return await syncEngine.uploadManuscriptBlobs(value.manuscriptId.trim(), typeof value?.hubId === 'string' && value.hubId.trim() ? value.hubId.trim() : undefined);
    }
    case 'syncSetHubUrl': {
      if (typeof value?.hubId !== 'string' || !value.hubId.trim()) throw new Error('缺少同步节点 ID。');
      const url = typeof value?.manualRemoteUrl === 'string' ? value.manualRemoteUrl.trim() : '';
      const status = syncPairing.setHubManualUrl(value.hubId.trim(), url);
      refreshSyncState();
      return controller.state.sync ?? status;
    }
    case 'syncDisable': {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: '停用并清除本机同步配置？本机已保存的文稿与词库仍保留，但本机同步密钥和已配对节点状态将被移除。',
        buttons: ['取消', '停用同步'],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice.response !== 1) throw new Error('已取消停用同步。');
      syncPairing.disableSync();
      controller.store.resetSyncMetadata();
      lastDiscoveredHubIds = [];
      lastSpoofedHubIds = [];
      refreshSyncState();
      return controller.state.sync;
    }
    case 'syncListDevices':
      return await syncPairing.listDevices(typeof value?.hubId === 'string' && value.hubId.trim() ? value.hubId.trim() : undefined);
    case 'syncUpdateDevice': {
      if (typeof value?.deviceId !== 'string' || !value.deviceId.trim()) throw new Error('缺少设备 ID。');
      const patch: { device_name?: string; scopes?: ('inference' | 'yanmo.sync')[] } = {};
      if (value?.deviceName !== undefined) {
        if (typeof value.deviceName !== 'string' || !value.deviceName.trim() || value.deviceName.trim().length > 100) {
          throw new Error('设备名称无效。');
        }
        patch.device_name = value.deviceName.trim();
      }
      if (value?.scopes !== undefined) patch.scopes = sanitizeScopes(value.scopes);
      return await syncPairing.updateDevice(value.deviceId.trim(), patch, typeof value?.hubId === 'string' && value.hubId.trim() ? value.hubId.trim() : undefined);
    }
    case 'syncRevokeDevice':
      if (typeof value?.deviceId !== 'string' || !value.deviceId.trim()) throw new Error('缺少设备 ID。');
      return await syncPairing.revokeDevice(value.deviceId.trim(), typeof value?.hubId === 'string' && value.hubId.trim() ? value.hubId.trim() : undefined);
    default: throw new Error('未知的言墨操作。');
  }
}
ipcMain.handle('yanmo:state', event => { authorize(event.sender.id, event.senderFrame?.url); return controller?.state ?? null; });
ipcMain.handle('yanmo:manuscriptAttachments', async (event, id: unknown) => {
  if (event.sender !== mainWindow.webContents || event.senderFrame?.url !== indexURL || typeof id !== 'string') {
    throw new Error('无效的文稿附件请求。');
  }
  if (controller.state.selectedID !== id) return {};
  let attachments = controller.store.getAttachments(id);
  if ((!attachments.audio?.byteLength || !attachments.screenshot?.byteLength) && syncEngine) {
    try {
      attachments = await syncEngine.ensureManuscriptAttachments(id);
    } catch { /* On-demand sync remains best-effort; local attachments still return. */ }
  }
  if (process.platform === 'darwin' && attachments.screenshot) {
    const screenshot = Buffer.from(attachments.screenshot);
    if (screenshot.toString('ascii', 4, 12) === 'ftypavif') {
      try {
        // Decode old AVIFs with ImageIO and send a PNG to the renderer, leaving the stored bytes intact.
        const { png } = await controller.native.call<{ png?: string }>('screenshot.preview', { avif: screenshot.toString('base64') });
        if (png) attachments.screenshot = Buffer.from(png, 'base64');
      } catch { /* A native preview failure leaves the original attachment available. */ }
    }
  }
  return attachments;
});
const appIcons = new Map<string, string | undefined>();
ipcMain.handle('yanmo:dailyUsage', async (event, day: unknown) => {
  authorize(event.sender.id, event.senderFrame?.url);
  if (event.sender !== mainWindow.webContents || typeof day !== 'string') throw new Error('无效的统计请求。');
  const usage = controller.store.dailyUsage(day);
  if (process.platform === 'darwin') {
    const missing = usage.apps.map(item => item.appKey).filter(key => !key.startsWith('name:') && !appIcons.has(key));
    if (missing.length) {
      const keys = missing.slice(0, 64);
      try {
        const icons = await controller.native.call<Record<string, string>>('appIcons', { appKeys: keys });
        for (const key of keys) appIcons.set(key, Object.hasOwn(icons, key) ? 'data:image/png;base64,' + icons[key] : undefined);
      } catch { /* The report remains available with generic app icons. */ }
    }
    for (const item of usage.apps) item.icon = appIcons.get(item.appKey);
  }
  return usage;
});
ipcMain.handle('yanmo:action', async (event, action, value) => {
  authorize(event.sender.id, event.senderFrame?.url);
  try {
    const data = await invoke(action, value, event.sender);
    return data === undefined ? { ok: true } : { ok: true, data };
  }
  catch (error) { controller?.notice((error as Error).message); return { ok: false, error: (error as Error).message }; }
});
function authorize(senderID: number, url?: string) {
  if (!url?.startsWith(indexURL) || ![mainWindow, overlay, translation].some(window => window && !window.isDestroyed() && window.webContents.id === senderID)) throw new Error('无效的界面请求。');
}
function canRequestScreenRecording() {
  const { keepHistory, saveRecordingScreenshot } = controller.state.settings;
  return process.platform === 'darwin' && keepHistory && saveRecordingScreenshot;
}

app.whenReady().then(async () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('言墨目前只支持 Mac 与 Windows。');
  const windows = process.platform === 'win32';
  const bridgePath = app.isPackaged ? join(root, windows ? 'native/YanmoBridge.exe' : 'native/YanmoBridge') : join(root, '.build/release/YanmoBridge');
  if (!existsSync(bridgePath)) throw new Error(windows ? 'Windows 系统桥接尚未接入，当前开发版先提供 Mac。' : '缺少系统桥接，请重新构建言墨。');
  const native = new NativeBridge(bridgePath);
  await native.start();
  let defaults: Settings = defaultSettings();
  if (!windows && !process.env.YANMO_DATA_DIR) {
    try { defaults = migrateSettings(await native.call('legacySettings')); } catch { /* Invalid legacy settings never overwrite the source. */ }
  }
  const store = new LibraryStore(dataDirectory, defaults, process.env.YANMO_DATA_DIR ? undefined : join(app.getPath('appData'), 'Yanmo/library.json'));
  const inference = new InferenceService({
    promptsDir: join(root, 'engine'),
    diagnosticsDir: join(dataDirectory, 'diagnostics'),
    usage: store.error ? undefined : store,
    archiveAudio: async (audio, taskId) => {
      if (typeof audio === 'string') {
        const res = await native.call<{ audioBase64?: string }>('audio.archive', { path: audio });
        return res.audioBase64 ? Buffer.from(res.audioBase64, 'base64') : undefined;
      }
      const res = await native.call<{ audioBase64?: string }>('audio.archive', { taskId }).catch(async () =>
        native.call<{ audioBase64?: string }>('audio.archive', { audioBase64: audio.toString('base64') }),
      );
      return res.audioBase64 ? Buffer.from(res.audioBase64, 'base64') : undefined;
    },
  });
  controller = new Controller(store, native, inference);
  controller.state.platform = windows ? 'windows' : 'mac';
  controller.captureRecordingScreenshot = captureRecordingScreenshot;
  refreshScreenRecordingAccess();
  native.on('permissions', refreshScreenRecordingAccess);
  if (app.isPackaged && !windows && process.arch === 'arm64') controller.state.update = { version: app.getVersion(), busy: false, message: '' };
  controller.ownSelection = async () => mainWindow?.isFocused() ? String(await mainWindow.webContents.executeJavaScript(
    `(() => { const field = document.activeElement; return field && 'selectionStart' in field && field.selectionEnd > field.selectionStart ? field.value.slice(field.selectionStart, field.selectionEnd) : String(getSelection() || ''); })()`)) : '';
  controller.state.launchAtLogin = app.getLoginItemSettings().openAtLogin;
  const storedKeys = readStoredKeys();
  controller.setOnlineKeys(onlineKeysFrom(storedKeys));
  controller.setAcpmToken(storedKeys.acpm || '');
  const hubStore = new FileKnownHubStore(dataDirectory);
  const acpmDataDir = process.env.YANMO_ACPM_DATA_DIR || undefined;
  syncPairing = new SyncPairingService({
    secretStore: safeStorageSyncSecretStore,
    hubStore,
    dataDir: acpmDataDir,
  });
  syncEngine = new SyncEngine({
    store,
    secretStore: safeStorageSyncSecretStore,
    hubStore,
    dataDir: acpmDataDir,
    onLibraryUpdated: () => controller.reloadLibraryFromStore(),
  });
  try {
    if (!store.error) syncEngine.ensureConfigured();
  } catch { /* Sync remains unconfigured if keychain is unavailable. */ }
  store.onLocalPersisted = () => scheduleBackgroundSync(3000);
  refreshSyncState();
  controller.on('state', broadcast);
  controller.on('meter', value => { if (overlay && !overlay.isDestroyed()) overlay.webContents.send('yanmo:meter', value); });
  controller.on('reveal', reveal);
  controller.on('translationShow', () => { translation.showInactive(); });
  controller.on('preferences', () => updateDock(mainWindow?.isVisible() ?? false));
  await createWindows();
  const icon = nativeImage.createFromPath(join(__dirname, 'tray.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon); tray.setToolTip('言墨'); tray.on('click', reveal);
  // A menu attached with setContextMenu also opens on a macOS left-click.
  tray.on('right-click', () => { if (trayMenu) tray.popUpContextMenu(trayMenu); });
  initialized = true;
  const diagnostics: Electron.MenuItemConstructorOptions[] = (!app.isPackaged || process.env.YANMO_QA === '1') ? [
    { type: 'separator' },
    { id: 'verifyTextEditInsertion', label: '验证文本编辑写入', click: () => {
      if (busy(controller.state.stage)) return;
      void (async () => {
        await native.call('insert', { text: '言墨 Electron 写入验证（合成文本）。\n' });
        controller.notice('已发送写入自检，请核对当前输入位置。');
      })().catch(error => controller.notice(error.message));
    } },
    { id: 'verifyTextEditTranslation', label: '验证文本编辑划词翻译', click: () => {
      if (busy(controller.state.stage)) return;
      void native.call('capture', { applicationBundleID: 'com.apple.TextEdit' }).then(target => controller.translateSelection(target)).catch(error => controller.notice(error.message));
    } },
  ] : [];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '言墨', submenu: [{ role: 'about' }, ...(controller.state.update ? [{ label: '检查更新…', click: showUpdates }] : []), { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => { controller.setPage('settings'); reveal(); } }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '文件', submenu: [{ label: '导入音频…', accelerator: 'CmdOrCtrl+O', click: () => void importAudio() }, { role: 'close' }, ...diagnostics] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: '打开言墨', click: reveal }] },
  ]));
  await controller.initialize();
  try {
    if (!store.error) store.gcExpiredTombstones();
  } catch { /* Tombstone GC stays best-effort on startup. */ }
  scheduleBackgroundSync(4000);
  syncPeriodicTimer = setInterval(() => {
    try {
      if (!store.error) store.gcExpiredTombstones();
    } catch { /* Ignore periodic GC failures. */ }
    scheduleBackgroundSync(0);
  }, 5 * 60_000);
  syncPeriodicTimer.unref();
  if (!app.isPackaged && process.argv.includes('--preview-overlay')) { showOverlay(); setTimeout(() => overlay.hide(), 5000); }
  const importIndex = process.argv.indexOf('--import-audio');
  if (importIndex >= 0 && process.argv[importIndex + 1]) await controller.importAudio(resolve(process.argv[importIndex + 1]));
}).catch(error => { dialog.showErrorBox('言墨启动未完成', error.message); app.quit(); });
app.on('activate', reveal);
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = undefined; }
  if (syncPeriodicTimer) { clearInterval(syncPeriodicTimer); syncPeriodicTimer = undefined; }
  if (controller) void controller.shutdown().finally(() => app.exit(0)); else app.exit(0);
});
