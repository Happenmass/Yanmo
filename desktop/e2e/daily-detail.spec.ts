import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultSettings, localDayDate, localDayKey, shiftLocalDay } from '../shared';
import { LibraryStore } from '../store';

test('日历显示各应用发送总量和真实文字请求用量，并区分未知用量和旧日期', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-daily-qa-'));
  const emptyAcpmDir = await mkdtemp(join(tmpdir(), 'yanmo-empty-acpm-'));
  const today = localDayKey(new Date());
  const yesterday = shiftLocalDay(today, -1);
  const earlier = shiftLocalDay(yesterday, -1);
  const oldDay = shiftLocalDay(earlier, -1);
  const timestamp = localDayDate(yesterday).getTime();
  const began = localDayDate(earlier).getTime();
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    calls++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ message: { content: '合成整理结果。' }, finish_reason: 'stop' }],
      ...(calls === 1 ? { usage: { prompt_tokens: 24, completion_tokens: 6 } } : {}),
    }));
  }).listen(0, '127.0.0.1');
  let application: ElectronApplication | undefined;
  try {
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const store = new LibraryStore(directory, defaultSettings());
    store.settings.onboarded = true;
    store.settings.showDock = false;
    store.settings.keepHistory = false;
    store.settings.online.text = { enabled: true, baseURL: `http://127.0.0.1:${port}/v1`, model: 'fixture' };
    store.library.manuscripts.push({ id: 'fixture', date: timestamp / 1000 - 978307200,
      original: '合成原文', text: '合成正文', seconds: 2, application: '合成测试', polished: true });
    store.persist();
    store.recordAppInput({ eventId: 'one', occurredAtMs: timestamp, appKey: 'com.apple.TextEdit', appName: '文本编辑', characters: 980, confirmed: true });
    store.recordAppInput({ eventId: 'two', occurredAtMs: timestamp, appKey: 'com.apple.TextEdit', appName: '文本编辑', characters: 260, confirmed: false });
    store.recordAppInput({ eventId: 'three', occurredAtMs: timestamp, appKey: 'com.apple.Safari', appName: 'Safari', characters: 320, confirmed: false });
    store.recordAppInput({ eventId: 'earlier', occurredAtMs: began, appKey: 'com.apple.TextEdit', appName: '文本编辑', characters: 1200, confirmed: false });
    store.close();
    const db = new DatabaseSync(join(directory, 'yanmo.db'));
    try {
      db.prepare("UPDATE settings SET value=? WHERE key='statistics_started_at_ms'").run(String(began));
      db.prepare(`
        INSERT INTO llm_usage_events VALUES
          ('polish', ?, 'polish', 'fixture', 'response', 24400, 200, 24600),
          ('hotword', ?, 'hotword_extract', 'fixture', 'response', 3000, 180, 3180),
          ('translate', ?, 'translate', 'fixture', 'response', 4500, 200, 4700)
      `).run(timestamp, timestamp, timestamp);
    } finally { db.close(); }
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      YANMO_DATA_DIR: directory, YANMO_ACPM_DATA_DIR: emptyAcpmDir, YANMO_QA: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.YANMO_QA_APP;
    application = await electron.launch({ args: executablePath ? [] : [resolve('.')], env, executablePath, cwd: executablePath ? tmpdir() : resolve('.') });
    const page = await application.firstWindow();
    await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).modelsChecked)).toBe(true);
    const yesterdayCell = page.locator(`button[data-day="${yesterday}"]`);
    await yesterdayCell.focus();
    await yesterdayCell.press('Enter');
    const details = page.getByRole('region', { name: '当日详情' });
    await expect(details.locator('time')).toHaveAttribute('datetime', yesterday);
    await expect(details.getByRole('columnheader')).toHaveText(['应用', '发送总量 ↓']);
    const rows = details.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('文本编辑');
    await expect(rows.nth(0).getByRole('cell')).toHaveText(['1,240']);
    await expect(rows.nth(1)).toContainText('Safari');
    await expect(rows.nth(1).getByRole('cell')).toHaveText(['320']);
    await expect(rows.nth(0).locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(page.getByRole('heading', { name: '随处落笔' })).toBeVisible();
    await expect(details.locator('.daily-sent small')).toContainText('+30.0%');
    await expect(details.locator('.daily-llm strong')).toHaveText('32,480');
    await page.screenshot({ path: test.info().outputPath('daily-detail.png') });
    await details.getByRole('button', { name: /前一天/ }).click();
    await expect(details.locator('time')).toHaveAttribute('datetime', earlier);
    await details.getByRole('button', { name: /前一天/ }).click();
    await expect(details.locator('time')).toHaveAttribute('datetime', oldDay);
    await expect(details).toContainText('这一天尚未开始记录使用统计');
    await details.getByRole('button', { name: /返回日历/ }).click();
    await expect(yesterdayCell).toBeFocused();

    await page.evaluate(async () => {
      await window.yanmo.invoke('select', 'fixture');
      await window.yanmo.invoke('polish');
      await window.yanmo.invoke('polish');
      await window.yanmo.invoke('page', 'desk');
    });
    expect(calls).toBe(2);
    await page.locator(`button[data-day="${today}"]`).click();
    await expect(details.getByRole('button', { name: /后一天/ })).toBeDisabled();
    await expect(details.locator('.daily-llm strong')).toHaveText('30');
    await expect(details.locator('.daily-llm dd')).toHaveText(['30', '0', '0']);
    await expect(details).toContainText('1 次调用未取得用量');
    await expect(details).toContainText('当天没有应用发送记录');
  } finally {
    if (application) await application.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
    await rm(emptyAcpmDir, { recursive: true, force: true });
  }
});
