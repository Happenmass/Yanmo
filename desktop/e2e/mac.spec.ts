import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultSettings } from '../shared';

let application: ElectronApplication;
let page: Page;
let directory: string;
const errors: string[] = [];
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'yanmo-electron-qa-'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(), showDock: false }));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), YANMO_DATA_DIR: directory, YANMO_QA: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = process.env.YANMO_QA_APP ? [] : [resolve('.')];
  if (process.env.YANMO_QA_AUDIO) args.push('--import-audio', process.env.YANMO_QA_AUDIO);
  application = await electron.launch({ args, env, executablePath: process.env.YANMO_QA_APP, cwd: process.env.YANMO_QA_APP ? tmpdir() : resolve('.') });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect.poll(() => application.evaluate(({ app }) => app.dock!.isVisible())).toBe(false);
  // checking is also false before the startup model check begins, so wait for its result.
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).modelsChecked)).toBe(true);
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).checking)).toBe(false);
});
test.afterAll(async () => { if (application) await application.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

test('首页使用真实统计，保留已确认的书案布局', async () => {
  if (process.env.YANMO_QA_AUDIO) {
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).library.manuscripts.length), { timeout: 150000 }).toBe(1);
    const state = await page.evaluate(() => window.yanmo.state());
    expect(state.draft).toMatch(/周五/); expect(state.draft).toContain('3500'); expect(state.draft).not.toContain('三千五百'); expect(state.draft).toMatch(/不是周四/);
    expect(state.asrResults.map(result => result.engine_name)).toEqual(['Qwen3-ASR', 'SenseVoice Small']);
    expect(state.asrResults[0].language).toBe('Chinese');
    expect(state.library.manuscripts[0].asrResults).toEqual(state.asrResults);
    await page.locator('.original summary').click();
    await expect(page.locator('.original')).toContainText('SenseVoice Small');
    await page.getByRole('button', { name: '书案', exact: true }).click();
  }
  await expect(page.getByText('言语之间，自有笔墨。')).toBeVisible();
  await expect(page.getByText('表达概览', { exact: true })).toBeVisible();
  await expect(page.locator('.calendar-day')).toHaveCount(140);
  await expect(page.locator('.desk').getByRole('button', { name: '开始录音' })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/yanmo-electron-desk.png', animations: 'disabled' });
});
test('词库增改、冲突校验与删除', async () => {
  await page.getByRole('button', { name: '词库', exact: true }).click();
  await page.getByRole('textbox', { name: '词语', exact: true }).fill('YanmoFixture');
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('合成测试词条');
  await page.getByRole('textbox', { name: '常见误识别', exact: true }).fill('测试误识别');
  await page.getByRole('button', { name: '加入词库', exact: true }).click();
  await expect(page.locator('.term-card')).toHaveCount(1);
  await page.getByRole('button', { name: '编辑YanmoFixture', exact: true }).click();
  await page.getByRole('textbox', { name: '词语', exact: true }).fill('YanmoFixtureEdited');
  await page.getByRole('button', { name: '保存词条', exact: true }).click();
  await expect(page.locator('.term-card h3')).toHaveText('YanmoFixtureEdited');
  await page.getByRole('button', { name: '移除YanmoFixtureEdited', exact: true }).click();
  await expect(page.getByText('从一个熟悉的名字开始。')).toBeVisible();
});
test('设置、两个翻译目标和模型环境状态', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('combobox', { name: '目标语言' }).nth(0).selectOption('ja');
  await page.getByRole('combobox', { name: '目标语言' }).nth(1).selectOption('zh-Hans');
  await page.getByRole('combobox', { name: '整理风格', exact: true }).selectOption('即时消息');
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).settings.voiceTarget)).toBe('ja');
  const state = await page.evaluate(() => window.yanmo.state());
  expect(state.settings.selectionTarget).toBe('zh-Hans'); expect(state.settings.style).toBe('即时消息');
  expect(state.models.asr).toBe(true); expect(state.models.sensevoice).toBe(true); expect(state.models.llm).toBe(true); expect(state.models.metal).toBe(true);
  expect(state.settings.modelSource).toBe('modelscope');
  const contextSetting = page.getByRole('checkbox', { name: '读取输入框光标前后各最多 300 字，辅助识别与纠错', exact: true });
  await contextSetting.click();
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).settings.readContext)).toBe(true);
  await expect(contextSetting).toBeChecked();
  await expect(page.getByRole('textbox', { name: '中英复核模型', exact: true })).toHaveValue('mlx-community/SenseVoiceSmall');
  await page.screenshot({ path: '/tmp/yanmo-electron-settings.png', animations: 'disabled' });
});
test('界面未启用 Node 或页面网络访问', async () => {
  expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined');
  expect(await page.evaluate(() => typeof (window as any).process)).toBe('undefined');
  await expect(page.locator('iframe')).toHaveCount(0);
  const overlay = application.windows().find(window => window.url().includes('view=overlay'))!;
  expect(await overlay.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(errors).toEqual([]);
});

test('真实采集时浮层不抢焦点且窗口边缘透明', async () => {
  test.skip(!process.env.YANMO_QA_AUDIO, '真实模型检查时一并验证采集');
  try {
    await page.evaluate(() => window.yanmo.invoke('record', 'dictation'));
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).stage)).toBe('recording');
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).seconds)).toBeGreaterThan(.7);
    const overlay = application.windows().find(window => window.url().includes('view=overlay'))!;
    const nativeWindow = await application.browserWindow(overlay);
    expect(await nativeWindow.evaluate(window => window.isFocused())).toBe(false);
    expect(await nativeWindow.evaluate(async window => (await window.capturePage()).toBitmap()[3])).toBe(0);
    await overlay.screenshot({ path: '/tmp/yanmo-electron-overlay.png', animations: 'disabled', omitBackground: true });
  } finally { await page.evaluate(() => window.yanmo.invoke('cancel')); }
});

test('真实麦克风、非激活浮层与文本编辑写入', async () => {
  test.skip(process.env.YANMO_QA_NATIVE !== '1', '显式开启系统交互检查后运行');
  await page.evaluate(() => window.yanmo.invoke('settings', { selectionTarget: 'en' }));
  const documentName = `Yanmo-QA-${basename(directory)}.txt`;
  const fixturePath = join(directory, documentName);
  await writeFile(fixturePath, '言墨 Electron 合成验证文稿。', 'utf8');
  execFileSync('osascript', ['-e', `tell application "TextEdit"
activate
open POSIX file ${JSON.stringify(fixturePath)}
end tell`]);
  const fixture = `document ${JSON.stringify(documentName)}`;
  try {
  await page.evaluate(() => window.yanmo.invoke('record', 'dictation'));
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).stage)).toBe('recording');
  const current = await page.evaluate(() => window.yanmo.state());
  expect(current.destinationName).toMatch(/文本编辑|TextEdit/);
  const overlay = application.windows().find(window => window.url().includes('view=overlay'))!;
  const nativeWindow = await application.browserWindow(overlay);
  expect(await nativeWindow.evaluate(window => window.isFocused())).toBe(false);
  expect(await nativeWindow.evaluate(async window => (await window.capturePage()).toBitmap()[3])).toBe(0);
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).seconds)).toBeGreaterThan(1);
  await overlay.screenshot({ path: '/tmp/yanmo-electron-overlay.png', animations: 'disabled' });
  await page.evaluate(() => window.yanmo.invoke('cancel'));
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).stage)).toBe('idle');
  await application.evaluate(({ Menu }) => { const menu = Menu.getApplicationMenu()!.getMenuItemById('verifyTextEditInsertion')!; menu.click(); });
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).notice)).toContain('已发送写入自检');
  const text = execFileSync('osascript', ['-e', `tell application "TextEdit" to get text of ${fixture}`], { encoding: 'utf8' });
  expect(text).toContain('言墨 Electron 写入验证（合成文本）。');
  execFileSync('osascript', ['-e', `tell application "TextEdit"\nset text of ${fixture} to "预算3500元，周五交付，不是周四。"\nactivate\nend tell\ntell application "System Events" to keystroke "a" using command down`]);
  await application.evaluate(({ Menu }) => { const menu = Menu.getApplicationMenu()!.getMenuItemById('verifyTextEditTranslation')!; menu.click(); });
  await expect.poll(() => page.evaluate(async () => { const value = (await window.yanmo.state()).translation; return value.result || value.error; }), { timeout: 90000 }).not.toBe('');
  const translation = application.windows().find(window => window.url().includes('view=translation'))!;
  const state = await page.evaluate(() => window.yanmo.state());
  expect(state.translation.error).toBe('');
  expect(state.translation.source).toContain('3500'); expect(state.translation.result).toContain('3500');
  await translation.screenshot({ path: '/tmp/yanmo-electron-translation.png', animations: 'disabled' });
  const unchanged = execFileSync('osascript', ['-e', `tell application "TextEdit" to get text of ${fixture}`], { encoding: 'utf8' });
  expect(unchanged.trim()).toBe('预算3500元，周五交付，不是周四。');
  } finally {
    await page.evaluate(() => window.yanmo.invoke('cancel'));
    await page.evaluate(() => window.yanmo.invoke('translationClose'));
    execFileSync('osascript', ['-e', `tell application "TextEdit" to close ${fixture} saving no`]);
  }
});
