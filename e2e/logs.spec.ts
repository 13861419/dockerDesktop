/**
 * 日志体验回归（1.92.0）：
 *  - Compose 日志弹窗：级别筛选 chips 存在、跟随刷新走 SSE（/logs/stream 200）、内容非空
 *  - 容器日志弹窗：chips 存在、跟随刷新走 SSE
 *
 * 前提：后端 9528（新代码）+ vite 9526（config 自动复用/拉起）。
 */
import { test, expect, Page } from '@playwright/test';

const USERNAME = process.env.E2E_USER || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'admin888';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('请输入用户名').fill(USERNAME);
  await page.getByPlaceholder('请输入密码').fill(PASSWORD);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });
}

test('Compose 日志弹窗：chips + SSE 跟随', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);

  await page.goto('/compose', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: '日志' }).first().click();
  await page.waitForTimeout(1500);

  const dialog = page.getByRole('dialog');
  for (const label of ['全部', '错误', '警告']) {
    await expect(dialog.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
  }

  const streamPromise = page.waitForResponse((r) => r.url().includes('/logs/stream'), { timeout: 15_000 });
  await dialog.getByRole('button', { name: '跟随刷新' }).click();
  await expect(dialog.getByRole('button', { name: '跟随中' })).toBeVisible({ timeout: 10_000 });
  const resp = await streamPromise;
  expect(resp.status()).toBe(200);

  await page.waitForTimeout(2000);
  const text = await page.locator('.log-viewer').textContent();
  expect((text || '').trim().length).toBeGreaterThan(20);
});

test('容器日志弹窗：chips + SSE 跟随', async ({ page }) => {
  await login(page);

  await page.goto('/containers', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: '日志' }).first().click();
  await page.waitForTimeout(1500);

  const dialog = page.getByRole('dialog');
  for (const label of ['全部', '错误', '警告']) {
    await expect(dialog.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
  }

  const streamPromise = page.waitForResponse((r) => r.url().includes('/logs/stream'), { timeout: 15_000 });
  await dialog.getByRole('button', { name: '跟随刷新' }).click();
  await expect(dialog.getByRole('button', { name: '跟随中' })).toBeVisible({ timeout: 10_000 });
  const resp = await streamPromise;
  expect(resp.status()).toBe(200);
});
