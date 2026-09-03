/**
 * E2E K8s 页面测试（1.13.0）
 *
 * 前提：面板服务已运行在 http://localhost:9528（无 Kubernetes 集群环境，断言 503 引导）。
 * 运行：cd e2e && npx playwright test k8s.spec.ts
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

test('K8s 概览：无集群时展示 kubeconfig 引导', async ({ page }) => {
  await login(page);
  await page.goto('/k8s');
  await expect(page.getByText(/Kubernetes 不可用|集群概览/).first()).toBeVisible({ timeout: 20_000 });
});

test('K8s 工作负载页可达（渲染标签栏或引导）', async ({ page }) => {
  await login(page);
  await page.goto('/k8s/workloads');
  await expect(page.getByText(/工作负载|Kubernetes 不可用/).first()).toBeVisible({ timeout: 20_000 });
});

test('K8s 事件页可达：实时按钮或引导可见', async ({ page }) => {
  await login(page);
  await page.goto('/k8s/events');
  await expect(page.getByText(/集群事件|Kubernetes 不可用/).first()).toBeVisible({ timeout: 20_000 });
});
