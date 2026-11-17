import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LibraryStore } from '../store';
import { cocoaNow, defaultSettings } from '../shared';

test('数据库文稿编辑与录音警告重启后保留，旧 JSON 不回退，删除连同音频', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-history-qa-'));
  const store = new LibraryStore(directory, { ...defaultSettings(), showDock: false });
  store.settings.onboarded = true;
  const item = { id: 'fixture', date: cocoaNow(), original: '合成原文', text: '合成正文', seconds: 2, application: '合成测试', polished: true };
  store.library.manuscripts = [item, { ...item, id: 'warning', text: '没有录音的合成正文', audioWarning: '录音未保存：音频压缩失败，文字处理继续。' }];
  store.persist({ id: item.id, data: Buffer.from('OggS-synthetic') }); store.close();
  let application: ElectronApplication | undefined;
  const launch = async () => {
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), YANMO_DATA_DIR: directory, YANMO_QA: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [resolve('.')], env, cwd: resolve('.') });
    const page = await application.firstWindow();
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).modelsChecked)).toBe(true);
    await page.getByRole('button', { name: '文稿', exact: true }).click();
    return page;
  };
  try {
    let page = await launch();
    await page.locator('.manuscript-select').filter({ hasText: '没有录音的合成正文' }).click();
    await expect(page.locator('.manuscript-editor .delivery-note')).toContainText('录音未保存');
    await page.locator('.manuscript-select').filter({ hasText: /^合成正文/ }).click();
    await expect(page.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveValue('合成正文');
    await page.getByRole('textbox', { name: '文稿正文', exact: true }).fill('编辑后的合成正文');
    // fill dispatches the renderer event; wait for its IPC save before quitting.
    await expect.poll(() => {
      const db = new DatabaseSync(join(directory, 'yanmo.db'), { readOnly: true });
      try { return db.prepare('SELECT text FROM manuscripts WHERE id=?').get('fixture')?.text; }
      finally { db.close(); }
    }).toBe('编辑后的合成正文');
    await application!.close(); application = undefined;
    await writeFile(join(directory, 'library.json'), JSON.stringify({ manuscripts: [item], lexicon: [] }));
    page = await launch();
    await page.locator('.manuscript-select').filter({ hasText: '编辑后的合成正文' }).click();
    await expect(page.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveValue('编辑后的合成正文');
    let db = new DatabaseSync(join(directory, 'yanmo.db'), { readOnly: true });
    expect(Number(db.prepare('SELECT length(audio_opus) AS n FROM manuscripts WHERE id=?').get('fixture')!.n)).toBeGreaterThan(0); db.close();
    await application!.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.locator('.manuscript-item').filter({ hasText: '编辑后的合成正文' }).getByRole('button', { name: '删除文稿' }).click();
    await expect(page.locator('.manuscript-item')).toHaveCount(1);
    await application!.close(); application = undefined;
    db = new DatabaseSync(join(directory, 'yanmo.db'), { readOnly: true });
    expect(db.prepare('SELECT id FROM manuscripts WHERE id=?').get('fixture')).toBeUndefined(); db.close();
  } finally { if (application) await application.close(); await rm(directory, { recursive: true, force: true }); }
});
