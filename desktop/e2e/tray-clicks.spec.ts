import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import type { Tray } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings } from '../shared';

type TrayProbe = { tray?: Tray; attachedMenus: boolean[]; popups: { label: string }[][]; menuReady: boolean };

test('菜单栏左键只打开主窗口，右键单独弹出菜单', async () => {
  test.skip(Boolean(process.env.YANMO_QA_APP), '此检查在源码启动前观察真实 Tray API；打包版另做系统点击验收');
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-tray-clicks-'));
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(), showDock: false }));
    const bootstrap = join(directory, 'bootstrap.cjs');
    // Observe the real Tray before startup, intercepting only popup display to avoid a modal native menu.
    await writeFile(bootstrap, `
      const electron = require('electron');
      const probe = globalThis.__yanmoTrayProbe = { attachedMenus: [], popups: [], menuReady: false };
      const buildMenu = electron.Menu.buildFromTemplate;
      electron.Menu.buildFromTemplate = function(template) {
        if (template.some(item => item.label === '打开言墨')) probe.menuReady = true;
        return buildMenu.call(this, template);
      };
      const trayOn = electron.Tray.prototype.on;
      electron.Tray.prototype.on = function(name, listener) {
        if (probe.tray !== this) {
          probe.tray = this;
          const setContextMenu = this.setContextMenu;
          this.setContextMenu = function(menu) {
            probe.attachedMenus.push(Boolean(menu));
            return setContextMenu.call(this, menu);
          };
          this.popUpContextMenu = function(menu) {
            probe.popups.push((menu?.items || []).map(item => ({ label: item.label })));
          };
        }
        return trayOn.call(this, name, listener);
      };
      require(${JSON.stringify(resolve('.electron/main.cjs'))});
    `);
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), YANMO_DATA_DIR: directory, YANMO_QA: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [bootstrap], env });
    await expect.poll(() => application!.evaluate(() => (globalThis as unknown as { __yanmoTrayProbe: TrayProbe }).__yanmoTrayProbe.menuReady)).toBe(true);
    const result = await application.evaluate(({ BrowserWindow }) => {
      const probe = (globalThis as unknown as { __yanmoTrayProbe: TrayProbe }).__yanmoTrayProbe;
      const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('view='))!;
      main.hide();
      probe.tray!.emit('click', {}, probe.tray!.getBounds(), {});
      const left = { visible: main.isVisible(), popups: probe.popups.length };
      main.hide();
      probe.tray!.emit('right-click', {}, probe.tray!.getBounds());
      return { attachedMenu: probe.attachedMenus.some(Boolean), left, right: { visible: main.isVisible(), popups: probe.popups.length, menu: probe.popups.at(-1) } };
    });
    // An attached native context menu also opens on a macOS left-click, outside the JS click handler.
    expect(result.attachedMenu).toBe(false);
    expect(result.left).toEqual({ visible: true, popups: 0 });
    expect(result.right.visible).toBe(false);
    expect(result.right.popups).toBe(1);
    expect(result.right.menu).toContainEqual({ label: '打开言墨' });
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
