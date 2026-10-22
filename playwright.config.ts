import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'desktop/e2e', workers: 1, timeout: 180000, reporter: 'list', use: { trace: 'off', screenshot: 'off' } });
