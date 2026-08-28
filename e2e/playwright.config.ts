/**
 * Playwright 配置（E2E 冒烟）
 *
 * 前提：面板后端已运行在 http://localhost:9528（API）。
 * 前端默认复用已运行的 vite dev（9526）；未运行时自动拉起（web/ 目录 npm run dev）。
 */
import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:9526',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        cwd: path.resolve(__dirname, '../web'),
        url: 'http://localhost:9526',
        reuseExistingServer: true,
        timeout: 120_000,
      },
  reporter: [['list']],
});
