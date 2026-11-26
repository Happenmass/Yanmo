import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultSettings, shortcutLabel } from '../shared';
import { startAcpmMock } from './acpm-mock';

function savedSettings(directory: string) {
  const db = new DatabaseSync(join(directory, 'yanmo.db'), { readOnly: true });
  try { return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(row => [String(row.key), JSON.parse(String(row.value))])); }
  finally { db.close(); }
}

// JSON is only a migration fixture; assertions read the authoritative database.
test('首次使用引导依次介绍四项功能，完成后可在设置中重新查看并切换 AcpmRuntime 模型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-guide-qa-'));
  const acpmMock = await startAcpmMock();
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(), showDock: false, onboarded: false }));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    YANMO_DATA_DIR: directory,
    YANMO_ACPM_DATA_DIR: acpmMock.dataDir,
    YANMO_QA: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: process.env.YANMO_QA_APP ? [] : [resolve('.')], env, executablePath: process.env.YANMO_QA_APP, cwd: tmpdir() });
  try {
    const page = await application.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const rail = page.getByRole('navigation', { name: '引导步骤' });
    await expect(rail).toBeVisible();
    expect(await page.evaluate(async () => (await window.yanmo.state()).settings.online.text.enabled)).toBe(false);
    await expect(page.locator('.sidebar')).toHaveAttribute('inert', '');
    // The guide asks for Accessibility exactly when FN cannot be captured yet.
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).checking)).toBe(false);
    const tap = await page.evaluate(async () => (await window.yanmo.state()).native.eventTap);
    await expect(page.getByRole('button', { name: '授予权限' })).toHaveCount(tap ? 0 : 1);
    if (process.env.YANMO_QA_SHOTS) await page.screenshot({ path: join(process.env.YANMO_QA_SHOTS, 'guide-permission.png'), animations: 'disabled' });
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
    await rail.getByRole('button', { name: /口述翻译/ }).click();
    await expect(field).toHaveValue('试写一句');
    // Shortcuts shown are the user's own, not hard-coded.
    await rail.getByRole('button', { name: /语音输入/ }).click();
    await expect(page.locator('.guide-text kbd')).toHaveText(defaultSettings().shortcuts.dictation.map(shortcutLabel));
    await rail.getByRole('button', { name: /翻译弹窗/ }).click();
    await expect(page.getByText('翻译使用 AcpmRuntime 本地文字模型')).toBeVisible();
    await page.getByRole('button', { name: '开始落笔' }).click();
    await expect(page.getByText('言语之间，自有笔墨。')).toBeVisible();
    await expect.poll(async () => savedSettings(directory).onboarded).toBe(true);
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
    await expect.poll(async () => savedSettings(directory).shortcuts).toEqual(defaultSettings().shortcuts);
    // Switch AcpmRuntime ASR model between 1.7B and 0.6B.
    const asrSelect = page.getByRole('combobox', { name: '语音识别模型' });
    await expect(asrSelect).toHaveValue('qwen3-asr-1.7b');
    await asrSelect.selectOption('qwen3-asr-0.6b');
    await expect.poll(async () => savedSettings(directory).acpm.asrModel).toBe('qwen3-asr-0.6b');
    if (process.env.YANMO_QA_SHOTS) await page.locator('.preference-section', { hasText: 'AcpmRuntime 服务' }).screenshot({ path: join(process.env.YANMO_QA_SHOTS, 'asr-preset.png'), animations: 'disabled' });
    await expect(asrSelect).toBeEnabled();
    await asrSelect.selectOption('qwen3-asr-1.7b');
    await expect.poll(async () => savedSettings(directory).acpm.asrModel).toBe(defaultSettings().acpm.asrModel);
    await page.getByRole('button', { name: '重新查看引导 →' }).click();
    await expect(rail).toBeVisible();
    await page.getByRole('button', { name: '跳过引导' }).click();
    await expect(page.getByText('言语之间，自有笔墨。')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await application.close(); await acpmMock.close(); await rm(directory, { recursive: true, force: true }); }
});

test('首次使用时 AcpmRuntime 未连接或模型未就绪，先停在准备页而非快捷键引导', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-setup-qa-'));
  const emptyAcpmDir = await mkdtemp(join(tmpdir(), 'yanmo-empty-acpm-'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(), showDock: false, onboarded: false }));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    YANMO_DATA_DIR: directory,
    YANMO_ACPM_DATA_DIR: emptyAcpmDir,
    YANMO_QA: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: process.env.YANMO_QA_APP ? [] : [resolve('.')], env, executablePath: process.env.YANMO_QA_APP, cwd: tmpdir() });
  try {
    const page = await application.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '先备好笔墨。' })).toBeVisible();
    await expect(page.getByRole('button', { name: '重新检测' })).toBeEnabled({ timeout: 60000 });
    await expect(page.getByRole('navigation', { name: '引导步骤' })).toHaveCount(0);
    if (process.env.YANMO_QA_SHOTS) await page.screenshot({ path: join(process.env.YANMO_QA_SHOTS, 'model-setup.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '跳过引导' }).click();
    await expect.poll(async () => savedSettings(directory).onboarded).toBe(true);
    expect(errors).toEqual([]);
  } finally { await application.close(); await rm(directory, { recursive: true, force: true }); await rm(emptyAcpmDir, { recursive: true, force: true }); }
});
