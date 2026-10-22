import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultSettings } from '../shared';

test('日语音频在转录模式下保留日语，中文翻译目标不影响正文', async () => {
  test.skip(!process.env.YANMO_QA_JAPANESE_AUDIO, '显式提供合成日语音频后运行实际模型检查');
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-japanese-qa-'));
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(), showDock: false, voiceTarget: 'zh-Hans' }));
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), YANMO_DATA_DIR: directory, YANMO_QA: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [...(process.env.YANMO_QA_APP ? [] : [resolve('.')]), '--import-audio', process.env.YANMO_QA_JAPANESE_AUDIO!], env, executablePath: process.env.YANMO_QA_APP, cwd: tmpdir() });
    const page = await application.firstWindow();
    await expect.poll(() => application!.evaluate(({ app }) => app.dock!.isVisible())).toBe(false);
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).library.manuscripts.length), { timeout: 150000 }).toBe(1);
    const state = await page.evaluate(() => window.yanmo.state());
    expect(state.settings.voiceTarget).toBe('zh-Hans');
    expect(state.asrResults).toHaveLength(1);
    expect(state.asrResults[0].language).toBe('Japanese');
    expect(state.asrResults[0].language_source).toBe('detected');
    expect(state.draft).toMatch(/[ぁ-ヿ]/);
    expect(state.draft).toContain('会議');
    // Both spellings preserve the spoken time; keep the model's wording.
    expect(state.draft).toMatch(/午後\s*(?:3|三)\s*時/);
    expect(state.draft).not.toMatch(/天气|会议/);
    expect(state.library.manuscripts[0].polished).toBe(true);
    if (process.env.YANMO_QA_APP) {
      const appPath = resolve(process.env.YANMO_QA_APP, '../../..');
      // Real inference must not add or replace bytecode inside signed resources.
      execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
    }
    await page.getByRole('button', { name: '文稿', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveValue(state.draft);
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
