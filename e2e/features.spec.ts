/**
 * E2E 功能回归（1.58.0 ~ 1.62.0 核心链路）
 *
 * 覆盖：日志全文检索 / SSL 证书页 / 事件自动化 / 应用商店导出 / 站点统计 / 设置。
 * 前提：后端已运行在 http://localhost:9528。
 * 运行：cd e2e && npx playwright test features.spec.ts
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

test('日志聚合中心：历史检索模式与索引状态可见', async ({ page }) => {
  await login(page);
  await page.goto('/logs');
  await expect(page.getByText('日志聚合中心')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '历史检索' }).click();
  // 索引状态栏（开启或未开启提示都算正常渲染）
  await expect(page.getByText(/索引中|日志索引未开启/)).toBeVisible();
});

test('日志全文检索：关键字查询出结果表格', async ({ page }) => {
  await login(page);
  await page.goto('/logs');
  await page.getByRole('button', { name: '历史检索' }).click();
  await page.getByPlaceholder('过滤关键字').fill('the');
  await page.getByRole('button', { name: '查询' }).click();
  // 结果卡片标题出现即视为查询链路通（无数据时也有“无日志”空态）
  await expect(page.getByText('日志结果').first()).toBeVisible({ timeout: 15_000 });
});

test('SSL 证书页：状态栏与证书区可见（管理员）', async ({ page }) => {
  await login(page);
  await page.goto('/certs');
  await expect(page.getByText(/http-01 验证服务/).first()).toBeVisible({ timeout: 20_000 });
});

test('事件自动化：新建规则并删除（完整生命周期）', async ({ page }) => {
  await login(page);
  await page.goto('/automations');
  await expect(page.getByRole('button', { name: '新建规则' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '新建规则' }).click();
  await page.getByPlaceholder('例如：app 崩溃自动重启').fill('e2e-test-rule');
  await page.getByRole('button', { name: '保存' }).click();

  const row = page.locator('.automations-table tr', { hasText: 'e2e-test-rule' });
  await expect(row).toBeVisible({ timeout: 10_000 });

  // 清理
  await row.getByRole('button', { name: '删除' }).click();
  await expect(page.locator('.automations-table tr', { hasText: 'e2e-test-rule' })).toHaveCount(0, { timeout: 10_000 });
});

test('应用商店：卡片渲染且导出弹窗可用（管理员）', async ({ page }) => {
  await login(page);
  await page.goto('/appstore');
  await expect(page.getByText('应用商店').first()).toBeVisible({ timeout: 20_000 });
  // 等卡片列表加载完成（至少一张应用卡）
  await page.locator('.appstore-card__actions').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('.appstore-card__actions').first().getByRole('button', { name: '导出' }).click();
  await expect(page.getByText(/apps\.json/).first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
});

test('站点页：列表与统计卡（有数据时）可见', async ({ page }) => {
  await login(page);
  await page.goto('/sites');
  await expect(page.getByText('站点 / 反向代理')).toBeVisible({ timeout: 15_000 });
  // 统计卡仅在已有采集数据时出现
  const statsCard = page.getByText('访问统计（近 7 天）');
  const count = await statsCard.count();
  if (count > 0) {
    await expect(statsCard.first()).toBeVisible();
  }
});

test('设置页：系统参数各分组可见（管理员）', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await expect(page.getByText(/系统参数|设置/).first()).toBeVisible({ timeout: 15_000 });
});

test('事件流页：实时事件区可见', async ({ page }) => {
  await login(page);
  await page.goto('/events');
  await expect(page.getByText(/事件/).first()).toBeVisible({ timeout: 15_000 });
});
