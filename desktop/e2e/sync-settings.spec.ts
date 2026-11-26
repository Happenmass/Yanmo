import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings } from '../shared';
import { createMockSyncHub } from '../tests/sync-hub-mock';

let application: ElectronApplication;
let page: Page;
let dataDir: string;
let acpmDir: string;
let server: Server;
let mockHub: ReturnType<typeof createMockSyncHub>;
const pageErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'yanmo-e2e-sync-data-'));
  acpmDir = await mkdtemp(join(tmpdir(), 'yanmo-e2e-sync-acpm-'));

  let resolvePort!: (url: string) => void;
  const portReady = new Promise<string>(r => { resolvePort = r; });

  server = createServer(async (req, res) => {
    const base = await portReady;
    const url = new URL(req.url || '/', base);
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      // Allow InferenceService Bearer startup check to see ready models.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          { id: 'qwen3-asr-1.7b', capability: 'asr', display_name: 'Qwen3-ASR 1.7B', installed: true, state: 'WARM', pin_policy: 'auto', idle_timeout_sec: 1200 },
          { id: 'yanmo-correct-4b-cot', capability: 'llm', display_name: 'Yanmo Correct 4B CoT', installed: true, state: 'WARM', pin_policy: 'auto', idle_timeout_sec: 1200 },
          { id: 'speech-vad-pyannote', capability: 'vad', display_name: 'Pyannote VAD', installed: true, state: 'WARM', pin_policy: 'pinned', idle_timeout_sec: 0 },
        ],
      }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v[0]);
    }
    const fetched = await mockHub.fetchImpl(url.toString(), {
      method: req.method,
      headers,
      body: body.byteLength ? new Uint8Array(body) : undefined,
    });
    const respHeaders: Record<string, string> = {};
    fetched.headers.forEach((v, k) => { respHeaders[k] = v; });
    const respBuf = Buffer.from(await fetched.arrayBuffer());
    res.writeHead(fetched.status, respHeaders);
    res.end(respBuf);
  }).listen(0, '127.0.0.1');

  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Mock sync server failed to bind.');
  const baseURL = `http://127.0.0.1:${addr.port}`;
  mockHub = createMockSyncHub({ baseURL });
  resolvePort(baseURL);
  mockHub.writeRuntimeJson(acpmDir);

  const settings = { ...defaultSettings(), showDock: false, onboarded: true };
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify(settings));

  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    YANMO_DATA_DIR: dataDir,
    YANMO_ACPM_DATA_DIR: acpmDir,
    YANMO_QA: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const args = process.env.YANMO_QA_APP ? [] : [resolve('.')];
  application = await electron.launch({
    args,
    env,
    executablePath: process.env.YANMO_QA_APP,
    cwd: process.env.YANMO_QA_APP ? tmpdir() : resolve('.'),
  });
  page = await application.firstWindow();
  await expect.poll(() => application.windows().find(w => !w.url().includes('view='))).toBeTruthy();
  page = application.windows().find(w => !w.url().includes('view='))!;
  page.on('pageerror', err => pageErrors.push(err.message));

  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).modelsChecked)).toBe(true);
});

test.afterAll(async () => {
  if (application) await application.close();
  server?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (acpmDir) await rm(acpmDir, { recursive: true, force: true });
});

test('设置页跨端同步与设备管理完整交互与视觉验收 (Phase 3B)', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const syncHeading = page.locator('.sync-section h3', { hasText: '跨端同步' });
  await syncHeading.scrollIntoViewIfNeeded();
  await expect(syncHeading).toBeVisible();

  // 1. 初始未开启状态
  await expect(page.getByText('跨端同步 · 未开启')).toBeVisible();
  await page.getByRole('button', { name: '开启跨端同步' }).click();

  // 2. 开启后进入已加密空间状态，复选框默认未勾选
  await expect(page.getByText('跨端同步 · 已开启（端到端加密）')).toBeVisible();
  await expect(page.locator('.sync-vault-id')).toContainText('空间 ');
  const cacheCheckbox = page.getByRole('checkbox', { name: /自动上传并缓存录音与截屏附件/ });
  await expect(cacheCheckbox).toBeVisible();
  await expect(cacheCheckbox).not.toBeChecked();

  // 切换复选框状态再复原，确认配置可持久化
  await cacheCheckbox.click();
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).settings.syncAutoCacheBlobs)).toBe(true);
  await cacheCheckbox.click();
  await expect.poll(() => page.evaluate(async () => (await window.yanmo.state()).settings.syncAutoCacheBlobs)).toBe(false);

  // 3. 授权范围单选 + 生成邀请二维码 + 反向等待二维码
  await page.getByRole('radio', { name: /仅推理/ }).click();
  await page.getByRole('button', { name: '生成邀请二维码' }).click();
  await expect(page.getByRole('img', { name: '配对二维码' })).toBeVisible();
  await expect(page.locator('.sync-qr-caption')).toContainText('仅共享推理算力');

  await page.getByRole('button', { name: '等待已有设备扫码' }).click();
  await expect(page.locator('.sync-qr-caption')).toContainText('等待已有设备扫码');

  // 切回默认本人设备邀请码
  await page.getByRole('radio', { name: /推理 \+ 同步/ }).click();
  await page.getByRole('button', { name: '生成邀请二维码' }).click();
  await expect(page.locator('.sync-qr-caption')).toContainText('仅限本人扫码');

  // 4. 在 mockHub 注入一台手机和一台仅推理同事手机，点击立即同步刷新设备列表并截屏验收
  const state = await page.evaluate(() => window.yanmo.state());
  const vaultId = state.sync!.vaultId!;
  const now = Date.now();
  mockHub.pairedDevices.set('peer-pixel-id', {
    device_id: 'peer-pixel-id',
    device_pubkey: 'pk-pixel',
    device_name: 'Gu 的 Pixel',
    platform: 'android',
    scopes: ['inference', 'yanmo.sync'],
    vault_id: vaultId,
    paired_at_ms: now - 3600_000,
    last_seen_at_ms: now,
    revoked_at_ms: null,
  });
  mockHub.pairedDevices.set('peer-colleague-id', {
    device_id: 'peer-colleague-id',
    device_pubkey: 'pk-colleague',
    device_name: '同事测试手机',
    platform: 'android',
    scopes: ['inference'],
    vault_id: null,
    paired_at_ms: now - 86_400_000,
    last_seen_at_ms: now - 86_400_000,
    revoked_at_ms: null,
  });

  await page.locator('.sync-status-actions').getByRole('button', { name: '立即同步' }).click();
  await expect(page.getByText('Gu 的 Pixel')).toBeVisible();
  await expect(page.getByText('同事测试手机')).toBeVisible();
  await expect(page.locator('.sync-tag.inference-only', { hasText: '仅推理' })).toBeVisible();
  await expect(page.locator('.sync-self', { hasText: '本机' })).toBeVisible();

  await syncHeading.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/yanmo-e2e-sync-settings.png', animations: 'disabled' });

  await page.locator('.sync-device-row').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/yanmo-e2e-sync-list.png', animations: 'disabled' });

  // 5. 编辑 Hub 地址 & 移除同事设备
  await page.locator('.sync-hub-row').getByRole('button', { name: '编辑地址' }).click();
  const hubInput = page.locator('.sync-hub-editor input');
  await hubInput.fill('http://192.168.1.99:18790');
  await page.locator('.sync-hub-editor').getByRole('button', { name: '保存地址' }).click();
  await expect(page.locator('.sync-hub-row .sync-row-meta')).toContainText('192.168.1.99');

  const colleagueRow = page.locator('.sync-device-row', { hasText: '同事测试手机' });
  await colleagueRow.getByRole('button', { name: '移除' }).click();
  await expect(page.getByText('同事测试手机')).toHaveCount(0);
  expect(mockHub.pairedDevices.get('peer-colleague-id')?.revoked_at_ms).toBeTruthy();
  expect(pageErrors).toEqual([]);
});
