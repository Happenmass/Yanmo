import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, shell, Tray } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Controller } from './controller';
import { NativeBridge, BackendClient } from './processes';
import { LibraryStore } from './store';
import { ACTIONS, Action, AppState, busy, Capability, CAPABILITIES, cocoaNow, defaultSettings, migrateSettings, Page, Settings } from './shared';

let mainWindow: BrowserWindow;
let overlay: BrowserWindow;
let translation: BrowserWindow;
let tray: Tray;
let trayMenu: Menu | undefined;
let controller: Controller;
let quitting = false;
let initialized = false;
let trayState = '';
let preparation: ChildProcess | undefined;
let runtimePython = '';
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
  translation.on('close', event => { if (!quitting) { event.preventDefault(); translation.hide(); void controller?.closeTranslation(); } });
  await Promise.all([mainWindow.loadFile(index), overlay.loadFile(index, { query: { view: 'overlay' } }), translation.loadFile(index, { query: { view: 'translation' } })]);
  reveal();
}
let overlayHide: NodeJS.Timeout | undefined;
function showOverlay() {
  if (quitting || overlay.isDestroyed()) return;
  clearTimeout(overlayHide); overlayHide = undefined;
  if (!overlay.isVisible()) {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    overlay.setPosition(Math.round(workArea.x + (workArea.width - overlaySize.width) / 2), workArea.y + workArea.height - overlaySize.height - overlaySize.bottom);
    overlay.showInactive();
  }
}
// Let the renderer's short fade finish before the panel disappears.
function hideOverlay() {
  if (overlayHide || !overlay.isVisible()) return;
  overlayHide = setTimeout(() => { overlayHide = undefined; if (!overlay.isDestroyed()) overlay.hide(); }, 170);
}
function broadcast(state: AppState) {
  if (quitting) return;
  for (const window of [mainWindow, overlay, translation]) if (window && !window.isDestroyed()) window.webContents.send('yanmo:state', state);
  if (overlay && !overlay.isDestroyed()) { if (state.overlayVisible && state.stage !== 'idle') showOverlay(); else hideOverlay(); }
  if (initialized) updateTray();
}
function updateTray() {
  if (quitting || !tray || tray.isDestroyed()) return;
  const state = controller.state;
  const key = state.stage + ':' + state.settings.voiceTarget;
  if (key === trayState) return;
  trayState = key;
  trayMenu = Menu.buildFromTemplate([
    { label: state.stage === 'recording' ? '结束录音' : '开始录音', enabled: !busy(state.stage) || state.stage === 'recording', click: () => void controller.perform('dictation') },
    { label: '口述翻译', enabled: !busy(state.stage) || state.stage === 'recording', click: () => void controller.perform('voiceTranslation') },
    { label: '取消', enabled: busy(state.stage), click: () => void controller.cancel() },
    { type: 'separator' }, { label: '打开言墨', click: reveal },
    { label: '设置…', click: () => { controller.setPage('settings'); reveal(); } },
    { type: 'separator' }, { label: '所有处理留在本机', enabled: false }, { label: '退出言墨', click: () => app.quit() },
  ]);
}
async function importAudio() {
  if (busy(controller.state.stage)) return;
  const result = await dialog.showOpenDialog(mainWindow, { title: '导入音频', properties: ['openFile'], filters: [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'aiff', 'aif', 'flac', 'ogg', 'aac', 'mp4'] }] });
  if (!result.canceled && result.filePaths[0]) await controller.importAudio(result.filePaths[0]);
}
async function prepareModels() {
  if (busy(controller.state.stage) || controller.state.checking || preparation) return;
  const settings = structuredClone(controller.state.settings);
  controller.state.checking = true;
  controller.notice('正在检查全局缓存，并准备模型（来源：' + (settings.modelSource === 'modelscope' ? 'ModelScope' : 'Hugging Face') + '）…');
  try {
    await new Promise<void>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HF_HUB_OFFLINE: '0', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUNBUFFERED: '1' };
      delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV;
      const child = spawn(runtimePython, ['-B', '-u', '-m', 'backend.prepare_models', '--source', settings.modelSource, '--asr', settings.asrModel, '--llm', settings.llmModel, '--sensevoice', settings.senseVoiceModel], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      preparation = child;
      child.stderr!.resume();
      createInterface({ input: child.stdout! }).on('line', line => {
        try {
          const value = JSON.parse(line);
          if (value.event === 'preparing') controller.notice('正在准备模型：' + value.model + '（' + (settings.modelSource === 'modelscope' ? 'ModelScope' : 'Hugging Face') + '）');
          if (value.event === 'prepared') controller.notice((value.reused ? '已复用全局缓存：' : '已准备：') + value.model);
        } catch { /* Download diagnostics never enter application history. */ }
      });
      child.once('error', reject);
      child.once('close', code => { preparation = undefined; if (code === 0) resolve(); else reject(new Error('模型准备未完成，请检查模型 ID、下载来源与网络后重试。已完成的缓存会继续复用。')); });
    });
    controller.notice('模型已准备，可在本机离线使用。');
  } finally { controller.state.checking = false; controller.changed(); await controller.checkModels(); }
}
// API keys are encrypted with safeStorage, whose key lives in the macOS Keychain; the file alone cannot be read elsewhere.
const keysPath = () => join(dataDirectory, 'online-keys.json');
function readOnlineKeys(): Partial<Record<Capability, string>> {
  if (!existsSync(keysPath())) return {};
  try {
    const stored = JSON.parse(readFileSync(keysPath(), 'utf8')) as Record<string, string>;
    return Object.fromEntries(Object.entries(stored).filter(([capability, value]) => Object.hasOwn(CAPABILITIES, capability) && typeof value === 'string')
      .map(([capability, value]) => [capability, safeStorage.decryptString(Buffer.from(value, 'base64'))]));
  } catch { return {}; }
}
function writeOnlineKeys(keys: Partial<Record<Capability, string>>) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('无法使用钥匙串加密，API Key 未保存。');
  const entries = Object.entries(keys).filter(([, value]) => value);
  if (!entries.length) { rmSync(keysPath(), { force: true }); return; }
  writeFileSync(keysPath(), JSON.stringify(Object.fromEntries(entries.map(([capability, value]) => [capability, safeStorage.encryptString(value!).toString('base64')]))), { mode: 0o600 });
}
async function saveOnline(value: any) {
  if (!value || !Object.hasOwn(CAPABILITIES, value.capability) || typeof value.enabled !== 'boolean' || typeof value.baseURL !== 'string' || typeof value.model !== 'string' || (value.key !== undefined && (typeof value.key !== 'string' || value.key.length > 1000))) throw new Error('在线模型配置无效。');
  const capability = value.capability as Capability;
  if (value.key?.trim()) { const keys = { ...readOnlineKeys(), [capability]: value.key.trim() }; writeOnlineKeys(keys); controller.setOnlineKeys(keys); }
  await controller.updateSettings({ online: { ...controller.state.settings.online, [capability]: { enabled: value.enabled, baseURL: value.baseURL.trim(), model: value.model.trim() } } });
  controller.notice(value.enabled ? CAPABILITIES[capability] + '将使用在线服务：' + value.model.trim() + '。' : '在线' + CAPABILITIES[capability] + '设置已保存，当前仍在本机处理。');
}
async function invoke(action: string, value: any) {
  if (!controller) throw new Error('言墨正在启动，请稍候。');
  switch (action) {
    case 'page': controller.setPage(value as Page); break;
    case 'clearNotice': controller.notice(''); break;
    case 'record': if (Object.hasOwn(ACTIONS, value)) await controller.perform(value as Action); break;
    case 'finish': await controller.finishRecording(); break;
    case 'cancel': await controller.cancel(); break;
    case 'import': await importAudio(); break;
    case 'check': await controller.checkModels(); break;
    case 'prepareModels': await prepareModels(); break;
    case 'permissions': {
      // The guide panel flies from the clicked button; renderer rects are relative to the window content.
      const bounds = mainWindow.getContentBounds();
      const source = value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) ? { x: bounds.x + value.x, y: bounds.y + value.y, width: value.width, height: value.height } : undefined;
      await controller.permissions(true, { app: resolve(process.execPath, '../../..'), source }); break;
    }
    case 'settings': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置值无效。');
      if ('retention' in value && value.retention && controller.state.library.manuscripts.some(item => item.date < cocoaNow() - value.retention * 86400)) {
        const choice = await dialog.showMessageBox(mainWindow, { type: 'warning', message: '更改保留时间后，超期文稿将从本机永久删除。', buttons: ['取消', '更改并删除超期文稿'], defaultId: 0, cancelId: 0 });
        if (choice.response !== 1) return;
      }
      await controller.updateSettings(value); break;
    }
    case 'capture': await controller.beginCapture(value); break;
    case 'captureEnd': await controller.endCapture(); break;
    case 'captureSave': await controller.saveCaptured(value); break;
    case 'shortcutRemove': if (value && Object.hasOwn(ACTIONS, value.action) && typeof value.id === 'string') await controller.removeShortcut(value.action, value.id); break;
    case 'select': if (typeof value === 'string') controller.select(value); break;
    case 'draft': if (value && typeof value.text === 'string') controller.updateDraft(value.id, value.text); break;
    case 'deleteManuscript': {
      if (typeof value !== 'string' || busy(controller.state.stage)) return;
      const choice = await dialog.showMessageBox(mainWindow, { type: 'warning', message: '删除这份文稿？此操作无法撤销。', buttons: ['取消', '删除文稿'], defaultId: 0, cancelId: 0 });
      if (choice.response === 1) controller.deleteManuscript(value); break;
    }
    case 'termSave': if (value && typeof value.term === 'string' && typeof value.hint === 'string' && Array.isArray(value.aliases) && value.aliases.every((alias: unknown) => typeof alias === 'string')) controller.saveTerm(value); else throw new Error('词条格式无效。'); break;
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
      const keys = readOnlineKeys(); delete keys[value as Capability]; writeOnlineKeys(keys); controller.setOnlineKeys(keys); controller.notice('已删除' + CAPABILITIES[value as Capability] + '的 API Key。'); break;
    }
    case 'login': app.setLoginItemSettings({ openAtLogin: value === true }); controller.state.launchAtLogin = app.getLoginItemSettings().openAtLogin; controller.changed(); break;
    default: throw new Error('未知的言墨操作。');
  }
}
ipcMain.handle('yanmo:state', event => { authorize(event.sender.id, event.senderFrame?.url); return controller?.state ?? null; });
ipcMain.handle('yanmo:action', async (event, action, value) => {
  authorize(event.sender.id, event.senderFrame?.url);
  try { await invoke(action, value); return { ok: true }; }
  catch (error) { controller?.notice((error as Error).message); return { ok: false, error: (error as Error).message }; }
});
function authorize(senderID: number, url?: string) {
  if (!url?.startsWith(indexURL) || ![mainWindow, overlay, translation].some(window => window && !window.isDestroyed() && window.webContents.id === senderID)) throw new Error('无效的界面请求。');
}

app.whenReady().then(async () => {
  if (process.platform !== 'darwin') throw new Error('当前开发版先提供 Mac MLX；Windows 运行时将在下一阶段接入。');
  const bridgePath = app.isPackaged ? join(root, 'native/YanmoBridge') : join(root, '.build/release/YanmoBridge');
  const python = process.env.YANMO_PYTHON || join(root, 'python/bin/python3.12');
  const developmentPython = join(root, 'runtime/macos/python/bin/python3.12');
  const native = new NativeBridge(bridgePath);
  await native.start();
  let defaults = defaultSettings();
  if (!process.env.YANMO_DATA_DIR) {
    try { defaults = migrateSettings(await native.call('legacySettings')); } catch { /* Invalid legacy settings never overwrite the source. */ }
  }
  const store = new LibraryStore(dataDirectory, defaults, process.env.YANMO_DATA_DIR ? undefined : join(app.getPath('appData'), 'Yanmo/library.json'));
  runtimePython = existsSync(python) ? python : developmentPython;
  const backend = new BackendClient(runtimePython, root);
  controller = new Controller(store, native, backend);
  controller.ownSelection = async () => mainWindow?.isFocused() ? String(await mainWindow.webContents.executeJavaScript(
    `(() => { const field = document.activeElement; return field && 'selectionStart' in field && field.selectionEnd > field.selectionStart ? field.value.slice(field.selectionStart, field.selectionEnd) : String(getSelection() || ''); })()`)) : '';
  controller.state.launchAtLogin = app.getLoginItemSettings().openAtLogin;
  controller.setOnlineKeys(readOnlineKeys());
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
    { label: '言墨', submenu: [{ role: 'about' }, { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => { controller.setPage('settings'); reveal(); } }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '文件', submenu: [{ label: '导入音频…', accelerator: 'CmdOrCtrl+O', click: () => void importAudio() }, { role: 'close' }, ...diagnostics] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: '打开言墨', click: reveal }] },
  ]));
  await controller.initialize();
  if (!app.isPackaged && process.argv.includes('--preview-overlay')) { showOverlay(); setTimeout(() => overlay.hide(), 5000); }
  const importIndex = process.argv.indexOf('--import-audio');
  if (importIndex >= 0 && process.argv[importIndex + 1]) await controller.importAudio(resolve(process.argv[importIndex + 1]));
}).catch(error => { dialog.showErrorBox('言墨启动未完成', error.message); app.quit(); });
app.on('activate', reveal);
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  preparation?.kill('SIGTERM');
  if (controller) void controller.shutdown().finally(() => app.exit(0)); else app.exit(0);
});
