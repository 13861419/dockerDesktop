/**
 * E2E 冒烟测试（登录 → 总览 → 容器 → 审批中心）
 *
 * 前提：面板服务已运行在 http://localhost:9528（可用 E2E_BASE_URL 覆盖）。
 * 运行：cd e2e && npm install && npx playwright test
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
  // 登录成功后跳转首页（总览）
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });
}

test('登录页加载并成功登录跳转总览', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByText('登录 Docker 管理面板')).toBeVisible();
  await login(page);
  // 总览页已渲染（侧边栏出现「容器」导航）
  await expect(page.getByRole('link', { name: /容器/ }).first()).toBeVisible();
});

test('容器页：列表与搜索框可见', async ({ page }) => {
  await login(page);
  await page.goto('/containers');
  await expect(page.getByPlaceholder('搜索 容器名 / 镜像 / ID')).toBeVisible({ timeout: 15_000 });
});

test('审批中心：状态筛选与记录区可见', async ({ page }) => {
  await login(page);
  await page.goto('/approvals');
  await expect(page.getByRole('button', { name: '待审批' })).toBeVisible({ timeout: 15_000 });
  // 「审批记录」文本同时出现在统计区与卡片标题（空数据时还有「暂无审批记录」空态），取首个命中即可
  await expect(page.getByText(/审批记录/).first()).toBeVisible();
});

test('安全基线页：规则清单可见（管理员）', async ({ page }) => {
  await login(page);
  await page.goto('/policy');
  await expect(page.getByText('基线规则清单')).toBeVisible({ timeout: 20_000 });
});
