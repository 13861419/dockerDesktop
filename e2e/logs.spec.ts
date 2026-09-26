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

/** CI 环境可能没有任何 compose 项目：缺失时经 API 建一个最小演示项目（busybox 循环打日志），保证行菜单「日志」可用 */
const DEMO_PROJECT = 'e2e-log-demo';

async function ensureDemoProject(page: Page): Promise<boolean> {
  const loginRes = await page.request.post('/api/auth/login', {
    data: { username: USERNAME, password: PASSWORD },
  });
  const token = ((await loginRes.json()) as { token: string }).token;
  const auth = { Authorization: `Bearer ${token}` };
  const listRes = await page.request.get('/api/compose', { headers: auth });
  const projects = (await listRes.json()) as Array<{ name: string }>;
  if (projects.some((p) => p.name === DEMO_PROJECT)) return false;
  await page.request.post('/api/compose', {
    headers: auth,
    data: {
      name: DEMO_PROJECT,
      content:
        'services:\n  demo:\n    image: busybox:latest\n    command: sh -c "while true; do echo e2e-compose-log-line; sleep 2; done"\n',
    },
  });
  // up -d：runner 有 Docker，busybox 拉取数秒；有容器才有日志内容
  await page.request.post(`/api/compose/${DEMO_PROJECT}/up`, { headers: auth, data: {} });
  await page.waitForTimeout(3000);
  return true;
}

test('Compose 日志弹窗：chips + SSE 跟随', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  const created = await ensureDemoProject(page);

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

  // CI 创建的演示项目跑完即清理（本地已有项目不受影响）
  if (created) {
    await page.request.delete(`/api/compose/${DEMO_PROJECT}`, { data: { volumes: true } });
  }
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
