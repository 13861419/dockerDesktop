/**
 * 计划任务 E2E：新建数据库备份任务 → 立即执行 → 执行历史可见 → 删除清理
 *
 * 前提：面板服务已运行在 http://localhost:9528（可用 E2E_BASE_URL 覆盖）。
 * 运行：cd e2e && npx playwright test tasks.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';

const USERNAME = process.env.E2E_USER || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'admin888';

/** 通过登录页完成登录 */
async function login(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('请输入用户名').fill(USERNAME);
  await page.getByPlaceholder('请输入密码').fill(PASSWORD);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });
}

test('计划任务全链路：新建 → 立即执行 → 执行历史成功 → 清理', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto('/tasks');

  // 1. 新建数据库备份任务
  await page.getByRole('button', { name: /新建任务/ }).first().click();
  const name = `e2e-backup-${Date.now()}`;
  await page.getByPlaceholder('如：每周清理未使用镜像').fill(name);
  await page.locator('.tasks__form select').first().selectOption('sqliteBackup');
  const cronInput = page.getByPlaceholder('0 3 * * *');
  await cronInput.fill('0 3 * * *');
  await page.getByRole('button', { name: '创建任务' }).click();
  await expect(page.getByText('任务已创建')).toBeVisible({ timeout: 10_000 });

  // 2. 在任务行上立即执行
  const row = page.locator('tr', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByRole('button', { name: '立即执行' }).click();

  // 3. 执行结果列出现「成功」标记
  await expect(row.locator('.tasks__result--ok')).toBeVisible({ timeout: 60_000 });

  // 4. 打开执行历史弹窗，成功记录可见
  await row.getByRole('button', { name: '日志' }).click();
  await expect(page.getByText(/执行历史/)).toBeVisible();
  await expect(page.locator('.modal').locator('.tasks__result--ok').first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');

  // 5. 清理：删除任务（确认框二次确认）
  await row.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除' }).last().click();
  await expect(page.getByText('任务已删除')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('tr', { hasText: name })).toHaveCount(0);
});
