import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings, shortcutLabel } from '../shared';

// A fresh install has no settings.json (covered by the store unit test); here the guide is forced on with the Dock hidden.
test('首次使用引导依次介绍四项功能，完成后可在设置中重新查看', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-guide-qa-'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(), showDock: false, onboarded: false }));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), YANMO_DATA_DIR: directory, YANMO_QA: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: process.env.YANMO_QA_APP ? [] : [resolve('.')], env, executablePath: process.env.YANMO_QA_APP, cwd: tmpdir() });
  try {
    const page = await application.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const rail = page.getByRole('navigation', { name: '引导步骤' });
    await expect(rail).toBeVisible();
    await expect(page.locator('.sidebar')).toHaveAttribute('inert', '');
    const headings = ['开口，即成文字。', '选中，即见译文。', '说中文，写外文。', '译文，另起一页。'];
    for (const [index, heading] of headings.entries()) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expect(rail.locator('[aria-current=step]')).toContainText(['语音输入', '划词翻译', '口述翻译', '翻译弹窗'][index]);
      await expect(page.locator('.guide-footer > span')).toHaveText(`${index + 1} / 4`);
      if (index < 3) await expect(page.locator('.guide-text kbd')).toHaveText([['FN'], ['FN + 空格'], ['FN + Shift']][index]);
      if (process.env.YANMO_QA_SHOTS) await page.screenshot({ path: join(process.env.YANMO_QA_SHOTS, `onboarding-${index + 1}.png`), animations: 'disabled' });
      if (index < 3) await page.getByRole('button', { name: '下一步' }).click();
    }
    // The practice field takes focus so a shortcut writes straight into it; typed text survives switching steps.
    await rail.getByRole('button', { name: /语音输入/ }).click();
    const field = page.getByRole('textbox', { name: '试写区' });
    await expect(field).toBeFocused();
    await page.keyboard.type('试写一句');
    await rail.getByRole('button', { name: /划词翻译/ }).click();
    await expect(field).toBeFocused();
    expect(await field.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe('Please bring the draft notes');
    // Native capture skips 言墨 itself, so the shortcut reads the selection from the focused page.
    await application.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows().find(window => window.getTitle() === '言墨')!.focus(); });
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).checking)).toBe(false);
    await page.evaluate(() => window.yanmo.invoke('record', 'selectionTranslation'));
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).translation.source)).toBe('Please bring the draft notes');
    await page.evaluate(() => window.yanmo.invoke('translationClose'));
    await rail.getByRole('button', { name: /口述翻译/ }).click();
    await expect(field).toHaveValue('试写一句');
    // Shortcuts shown are the user's own, not hard-coded.
    await rail.getByRole('button', { name: /语音输入/ }).click();
    await expect(page.locator('.guide-text kbd')).toHaveText(defaultSettings().shortcuts.dictation.map(shortcutLabel));
    await rail.getByRole('button', { name: /翻译弹窗/ }).click();
    await page.getByRole('button', { name: '开始落笔' }).click();
    await expect(page.getByText('言语之间，自有笔墨。')).toBeVisible();
    await expect.poll(async () => JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).onboarded).toBe(true);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.locator('.shortcut-row kbd')).toHaveText(['FN', 'FN + Shift', 'FN + 空格']);
    await page.evaluate(() => window.yanmo.invoke('settings', { shortcuts: {
      dictation: [{ keyCode: 0, modifiers: 0, keyLabel: '右 Control', modifierKeys: [62] }],
      voiceTranslation: [{ keyCode: 0, modifiers: 0, keyLabel: '右 Shift + 右 Control', modifierKeys: [60, 62] }],
      selectionTranslation: [{ keyCode: 49, modifiers: 4096, keyLabel: 'Space' }],
    } }));
    await expect(page.locator('.shortcut-row kbd')).toHaveText(['右 Control', '右 Shift + 右 Control', 'Control + 空格']);
    for (let index = 0; index < 3; index++) await page.locator('.shortcut-editor').nth(index).getByRole('button', { name: '恢复默认' }).click();
    await expect(page.locator('.shortcut-row kbd')).toHaveText(['FN', 'FN + Shift', 'FN + 空格']);
    await expect.poll(async () => JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).shortcuts).toEqual(defaultSettings().shortcuts);
    // The low-memory ASR preset only swaps the model ID; the default stays 1.7B.
    const preset = page.getByRole('combobox', { name: '语音识别规格' });
    await expect(preset).toHaveValue('mlx-community/Qwen3-ASR-1.7B-8bit');
    await preset.selectOption({ label: '低内存 · Qwen3-ASR 0.6B' });
    await expect.poll(async () => JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).asrModel).toBe('mlx-community/Qwen3-ASR-0.6B-8bit');
    if (process.env.YANMO_QA_SHOTS) await page.locator('.preference-section', { hasText: '本地模型' }).screenshot({ path: join(process.env.YANMO_QA_SHOTS, 'asr-preset.png'), animations: 'disabled' });
    await expect(page.getByRole('textbox', { name: '语音识别模型' })).toHaveValue('mlx-community/Qwen3-ASR-0.6B-8bit');
    await expect(preset).toBeEnabled();
    await preset.selectOption('mlx-community/Qwen3-ASR-1.7B-8bit');
    await expect.poll(async () => JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).asrModel).toBe(defaultSettings().asrModel);
    await page.getByRole('button', { name: '重新查看引导 →' }).click();
    await expect(rail).toBeVisible();
    await page.getByRole('button', { name: '跳过引导' }).click();
    await expect(page.getByText('言语之间，自有笔墨。')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await application.close(); await rm(directory, { recursive: true, force: true }); }
});

test('首次使用时模型未就绪，先停在模型准备页而非快捷键引导', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-setup-qa-'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(), showDock: false, onboarded: false, asrModel: 'yanmo-qa/missing-asr' }));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), YANMO_DATA_DIR: directory, YANMO_QA: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: process.env.YANMO_QA_APP ? [] : [resolve('.')], env, executablePath: process.env.YANMO_QA_APP, cwd: tmpdir() });
  try {
    const page = await application.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '先备好笔墨。' })).toBeVisible();
    await expect(page.getByRole('button', { name: '下载模型' })).toBeEnabled({ timeout: 60000 });
    await expect(page.getByRole('navigation', { name: '引导步骤' })).toHaveCount(0);
    if (process.env.YANMO_QA_SHOTS) await page.screenshot({ path: join(process.env.YANMO_QA_SHOTS, 'model-setup.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '跳过引导' }).click();
    await expect.poll(async () => JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).onboarded).toBe(true);
    expect(errors).toEqual([]);
  } finally { await application.close(); await rm(directory, { recursive: true, force: true }); }
});
