import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LibraryStore } from '../store';
import { cocoaNow, defaultSettings } from '../shared';

test('文稿预览可播放录音并放大 JPEG 与 AVIF，附件随文稿重启保留及删除', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-history-qa-'));
  const store = new LibraryStore(directory, { ...defaultSettings(), showDock: false });
  store.settings.onboarded = true;
  const item = { id: 'fixture', date: cocoaNow(), original: '合成原文', text: '合成正文', seconds: 2, application: '合成测试', polished: true };
  const endedAt = Date.now();
  store.library.manuscripts = [
    { ...item, recordingEndedAtMs: endedAt },
    { ...item, id: 'avif', text: '只有截屏的文稿', recordingEndedAtMs: endedAt },
    { ...item, id: 'warning', text: '没有录音的合成正文', audioWarning: '录音未保存：音频压缩失败，文字处理继续。' },
  ];
  const media = (format: string) => readFile(join(__dirname, 'fixtures', `manuscript-preview.${format}`));
  store.persist({ id: item.id, audioOpus: await media('ogg'), screenshotImage: await media('jpg') });
  store.persist({ id: 'avif', screenshotImage: await media('avif') });
  if (process.platform === 'darwin') {
    store.library.manuscripts.push({ ...item, id: 'odd-avif', text: '旧版保存的奇数高度截屏', recordingEndedAtMs: endedAt });
    store.persist({ id: 'odd-avif', screenshotImage: await media('odd.avif') });
  }
  store.close();
  let application: ElectronApplication | undefined;
  const launch = async () => {
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), YANMO_DATA_DIR: directory, YANMO_QA: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.YANMO_QA_APP;
    application = await electron.launch({ args: executablePath ? [] : [resolve('.')], executablePath, env, cwd: resolve('.') });
    const page = await application.firstWindow();
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).modelsChecked)).toBe(true);
    return page;
  };
  try {
    let page = await launch();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const screenshotToggle = () => page.getByRole('checkbox', { name: '录音结束时保存截屏' });
    await expect(screenshotToggle()).not.toBeChecked();
    await screenshotToggle().click();
    await expect(screenshotToggle()).toBeChecked();
    await page.getByRole('button', { name: '文稿', exact: true }).click();
    await page.locator('.manuscript-select').filter({ hasText: '没有录音的合成正文' }).click();
    await expect(page.locator('.manuscript-editor .delivery-note')).toContainText('录音未保存');
    await expect(page.getByRole('region', { name: '文稿附件' })).toHaveCount(0);
    await page.locator('.manuscript-select').filter({ hasText: '只有截屏的文稿' }).click();
    const thumbnail = page.getByRole('img', { name: '录音结束时的屏幕缩略图' });
    await expect.poll(() => thumbnail.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(32);
    await expect(page.getByRole('button', { name: '播放录音' })).toHaveCount(0);
    if (process.platform === 'darwin') {
      await page.locator('.manuscript-select').filter({ hasText: '旧版保存的奇数高度截屏' }).click();
      await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalHeight)).toBe(1241);
      const opacity = async (image: HTMLImageElement) => {
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3];
      };
      expect.soft(await thumbnail.evaluate(opacity)).toBe(255);
      await page.getByRole('button', { name: '放大录音结束截屏' }).click();
      const preview = page.getByRole('dialog', { name: '录音结束截屏' });
      const fullImage = preview.locator('img');
      await expect.poll(() => fullImage.evaluate((image: HTMLImageElement) => image.naturalHeight)).toBe(1241);
      expect.soft(await fullImage.evaluate(opacity)).toBe(255);
      await expect.soft(page.locator('.topbar')).toHaveCSS('-webkit-app-region', 'no-drag', { timeout: 1000 });
      await page.getByRole('button', { name: '关闭截屏预览' }).click();
      await expect(preview).not.toBeVisible();
      await expect(page.locator('.topbar')).toHaveCSS('-webkit-app-region', 'drag');
    }
    await page.locator('.manuscript-select').filter({ hasText: /^合成正文/ }).click();
    await expect.poll(() => thumbnail.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(32);
    await page.getByRole('button', { name: '放大录音结束截屏' }).click();
    const dialog = page.getByRole('dialog', { name: '录音结束截屏' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    if (process.env.YANMO_QA_SHOTS) await page.screenshot({ path: join(process.env.YANMO_QA_SHOTS, 'manuscript-attachments.png'), animations: 'disabled' });
    const play = page.getByRole('button', { name: '播放录音' });
    const pause = page.getByRole('button', { name: '暂停录音' });
    const audio = page.locator('.recording-preview audio');
    await play.click();
    await expect(pause).toBeVisible();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
    await pause.click();
    await expect(play).toBeVisible();
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
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(screenshotToggle()).toBeChecked();
    await screenshotToggle().click();
    await expect(screenshotToggle()).not.toBeChecked();
    await page.getByRole('button', { name: '文稿', exact: true }).click();
    await page.locator('.manuscript-select').filter({ hasText: '编辑后的合成正文' }).click();
    await expect(page.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveValue('编辑后的合成正文');
    let db = new DatabaseSync(join(directory, 'yanmo.db'), { readOnly: true });
    const row = db.prepare('SELECT length(audio_opus) AS audio, length(screenshot_image) AS screenshot FROM manuscripts WHERE id=?').get('fixture')!;
    expect(Number(row.audio)).toBeGreaterThan(0);
    expect(Number(row.screenshot)).toBeGreaterThan(0);
    db.close();
    await application!.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.locator('.manuscript-item').filter({ hasText: '编辑后的合成正文' }).getByRole('button', { name: '删除文稿' }).click();
    await expect(page.locator('.manuscript-item')).toHaveCount(process.platform === 'darwin' ? 3 : 2);
    await application!.close(); application = undefined;
    db = new DatabaseSync(join(directory, 'yanmo.db'), { readOnly: true });
    expect(db.prepare('SELECT id FROM manuscripts WHERE id=?').get('fixture')).toBeUndefined(); db.close();
  } finally { if (application) await application.close(); await rm(directory, { recursive: true, force: true }); }
});
