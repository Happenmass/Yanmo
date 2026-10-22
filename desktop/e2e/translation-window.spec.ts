import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings } from '../shared';

let application: ElectronApplication;
let translation: Page;
let directory: string;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'yanmo-translation-window-'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(), showDock: false }));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), YANMO_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: process.env.YANMO_QA_APP ? [] : [resolve('.')], env, executablePath: process.env.YANMO_QA_APP });
  await expect.poll(() => application.windows().length).toBe(3);
  translation = application.windows().find(page => page.url().includes('view=translation'))!;
  await expect(translation.locator('.translation-heading')).toBeAttached();
  await expect.poll(() => application.evaluate(({ app }) => app.dock!.isVisible())).toBe(false);
  const window = await application.browserWindow(translation);
  await window.evaluate(window => { window.setPosition(180, 100); window.showInactive(); });
});
test.afterAll(async () => { if (application) await application.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

test('划词翻译作为普通窗口，切换应用后不强制置顶或跟随所有空间', async () => {
  const window = await application.browserWindow(translation);
  expect(await window.evaluate(window => window.isAlwaysOnTop())).toBe(false);
  expect(await window.evaluate(window => window.isVisibleOnAllWorkspaces())).toBe(false);
  expect(await window.evaluate(window => window.isMovable())).toBe(true);
});

test('顶部空白标题区可拖动，翻译控件仍可点击', async () => {
  const region = await translation.evaluate(() => {
    const element = document.elementFromPoint(300, 15)!;
    return getComputedStyle(element).getPropertyValue('-webkit-app-region');
  });
  expect(region).toBe('drag');
  const language = translation.getByRole('combobox', { name: '目标语言' });
  await expect(language).toBeEnabled();
  const sourceMode = translation.getByRole('button', { name: '源码', exact: true });
  await sourceMode.click();
  await expect(sourceMode).toHaveAttribute('aria-pressed', 'true');
  await translation.getByRole('button', { name: '关闭', exact: true }).click();
  const window = await application.browserWindow(translation);
  await expect.poll(() => window.evaluate(window => window.isVisible())).toBe(false);
});

test('关闭主窗口后隐藏程序坞图标，反复重新打开仍可恢复', async () => {
  test.skip(process.env.YANMO_QA_DOCK !== '1', '显式开启程序坞系统检查后运行，避免干扰当前桌面');
  const main = application.windows().find(page => page.url().endsWith('/web/index.html'))!;
  const window = await application.browserWindow(main);
  const dockVisible = () => application.evaluate(({ app }) => app.dock!.isVisible());
  await main.evaluate(() => globalThis.window.yanmo.invoke('settings', { showDock: true }));
  await expect.poll(dockVisible).toBe(true);
  for (let index = 0; index < 3; index++) {
    await window.evaluate(window => window.close());
    await expect.poll(() => window.evaluate(window => window.isVisible())).toBe(false);
    await expect.poll(dockVisible).toBe(false);
    expect(await window.evaluate(window => window.isDestroyed())).toBe(false);
    // The Window menu and tray's “打开言墨” use the same reveal handler.
    await application.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()!.items.find(item => item.label === '窗口')!.submenu!;
      menu.items.find(item => item.label === '打开言墨')!.click();
    });
    await expect.poll(() => window.evaluate(window => window.isVisible())).toBe(true);
    await expect.poll(dockVisible).toBe(true);
  }
});

test('后台译文不唤回程序坞图标，始终隐藏设置仍有效', async () => {
  test.skip(process.env.YANMO_QA_DOCK !== '1', '显式开启程序坞系统检查后运行，避免干扰当前桌面');
  const main = application.windows().find(page => page.url().endsWith('/web/index.html'))!;
  const window = await application.browserWindow(main);
  const popup = await application.browserWindow(translation);
  const dockVisible = () => application.evaluate(({ app }) => app.dock!.isVisible());
  const reopen = () => application.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()!.items.find(item => item.label === '窗口')!.submenu!;
    menu.items.find(item => item.label === '打开言墨')!.click();
  });
  await window.evaluate(window => window.close());
  await expect.poll(dockVisible).toBe(false);
  await popup.evaluate(window => window.showInactive());
  await expect.poll(() => popup.evaluate(window => window.isVisible())).toBe(true);
  expect(await dockVisible()).toBe(false);
  await popup.evaluate(window => window.close());
  await main.evaluate(() => globalThis.window.yanmo.invoke('settings', { showDock: false }));
  await reopen();
  await expect.poll(() => window.evaluate(window => window.isVisible())).toBe(true);
  expect(await dockVisible()).toBe(false);
  await window.evaluate(window => window.close());
  await expect.poll(() => window.evaluate(window => window.isVisible())).toBe(false);
  await main.evaluate(() => globalThis.window.yanmo.invoke('settings', { showDock: true }));
  expect(await dockVisible()).toBe(false);
  await reopen();
  await expect.poll(dockVisible).toBe(true);
});
