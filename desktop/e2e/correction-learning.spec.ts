import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings } from '../shared';

test('入库提醒按设计显示，不聚焦，撤销移除本次词条', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-learning-ui-'));
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(), showDock: false }));
    const bootstrap = join(directory, 'bootstrap.cjs');
    // Capture the real controller through its EventEmitter boundary; no production QA API.
    await writeFile(bootstrap, `
      const {EventEmitter}=require('node:events'); const emit=EventEmitter.prototype.emit;
      EventEmitter.prototype.emit=function(name,...args){
        if(name==='state' && typeof this.undoLearnedTerms==='function') globalThis.learningController=this;
        return emit.call(this,name,...args);
      };
      require(${JSON.stringify(resolve('.electron/main.cjs'))});
    `);
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),  YANMO_DATA_DIR: directory, YANMO_QA: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [bootstrap], env });
    const page = await application.firstWindow();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).modelsChecked)).toBe(true);
    await application.evaluate(async () => {
      const controller = (globalThis as any).learningController;
      controller.state.settings.online.text = { enabled: true, baseURL: 'http://127.0.0.1:9/v1', model: 'fixture' };
      controller.backend.extractCorrectionTerms = async () => ['沈砚'];
      controller.observationID = 'ui-fixture';
      controller.native.emit('correction', { observationId: 'ui-fixture', original: '明天联系沈言确认方案。', text: '明天联系沈砚确认方案。' });
    });
    const overlay = application.windows().find(window => window.url().includes('view=overlay'))!;
    await expect(overlay.getByRole('status')).toHaveText('已加入词库：沈砚撤销');
    expect(await application.evaluate(({ BrowserWindow }) => {
      const panel = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=overlay'))!;
      return { focused: panel.isFocused(), focusable: panel.isFocusable(), width: panel.getSize()[0] };
    })).toEqual({ focused: false, focusable: false, width: 440 });
    const bounds = await overlay.locator('.learning-toast').boundingBox();
    expect(bounds!.width).toBeCloseTo(400); expect(bounds!.height).toBeCloseTo(48); expect(bounds!.x).toBeCloseTo(20);
    await overlay.screenshot({ path: '.local/correction-learning/toast.png', animations: 'disabled' });
    const focusedBefore = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id);
    await overlay.getByRole('button', { name: '撤销', exact: true }).click();
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(focusedBefore);
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).library.lexicon.length)).toBe(0);
    await expect(overlay.getByRole('status')).toHaveCount(0);
    // A subsequent notice expires without requiring any interaction.
    await application.evaluate(() => {
      const c=(globalThis as any).learningController; c.observationID='expire';
      c.native.emit('correction',{observationId:'expire',original:'联系沈言。',text:'联系沈砚。'});
    });
    await expect(overlay.getByRole('status')).toBeVisible();
    await expect(overlay.getByRole('status')).toHaveCount(0, { timeout: 8000 });
    expect(await page.evaluate(async () => (await window.yanmo.state()).library.lexicon.map(t => t.term))).toEqual(['沈砚']);
  } finally { await application?.close(); await rm(directory, { recursive: true, force: true }); }
});
