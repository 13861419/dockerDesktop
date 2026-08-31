/**
 * 文档截图采集（CAPTURE=1 时运行）
 *
 * 用法：cd e2e && CAPTURE=1 npx playwright test capture.spec.ts
 * 输出：../images/<name>.png（README / 操作手册引用）
 */
import { test, type Page } from '@playwright/test';

test.skip(!process.env.CAPTURE, '仅 CAPTURE=1 时运行截图采集');

const USERNAME = process.env.E2E_USER || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'admin888';

/** 路由 → 截图文件名（覆盖 README 与操作手册引用的语义命名图） */
const ROUTES: Array<[string, string]> = [
  ['overview', '/'],
  ['health', '/health'],
  ['containers', '/containers'],
  ['templates', '/templates'],
  ['orchestrate', '/orchestrate'],
  ['images', '/images'],
  ['build', '/build'],
  ['volumes-networks', '/volumes'],
  ['compose', '/compose'],
  ['appstore', '/appstore'],
  ['tasks', '/tasks'],
  ['files-terminal', '/files'],
  ['engines', '/engines'],
  ['cloudbackup', '/cloudbackup'],
  ['swarm', '/swarm'],
  ['backups', '/backups'],
  ['databases', '/databases'],
  ['settings', '/settings'],
  ['hub', '/hub'],
  ['operation-logs', '/operation-logs'],
  ['notifications', '/notifications'],
  ['events', '/events'],
  ['sites', '/sites'],
  ['firewall', '/firewall'],
  ['policy', '/policy'],
  ['approvals', '/approvals'],
  ['tools', '/tools'],
  ['ports', '/ports'],
  ['assistant', '/assistant'],
  ['help', '/help'],
];

/** 复用文件：多图引用同一整页截图（消除手册死链） */
const COPIES: Array<[string, string]> = [
  ['config-import-export.png', 'settings.png'],
  ['cross-engine-overview.png', 'overview.png'],
  ['monitoring-history.png', 'overview.png'],
  ['resource-dashboard.png', 'overview.png'],
  ['global-search.png', 'containers.png'],
  ['cross-engine-migration.png', 'engines.png'],
  ['hub-enhanced.png', 'hub.png'],
  ['vuln-scan.png', 'hub.png'],
  ['settings-db-backup.png', 'settings.png'],
];

async function login(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('请输入用户名').fill(USERNAME);
  await page.getByPlaceholder('请输入密码').fill(PASSWORD);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });
}

test('采集全部页面截图', async ({ page }) => {
  test.setTimeout(600_000);
  await login(page);

  // 每页独立 Page（同一 Context 共享登录态）：避免单 Page 累积 30 次整页截图导致渲染进程崩溃
  for (const [name, path] of ROUTES) {
    const p = await page.context().newPage();
    try {
      await p.goto(path, { waitUntil: 'domcontentloaded' });
      // 轮询型页面（监控/容器统计）networkidle 永不触发，固定等待渲染稳定即可
      await p.waitForTimeout(2500);
      await p.screenshot({ path: `../images/${name}.png`, fullPage: true, timeout: 20_000 });
    } catch (e) {
      console.warn(`[capture] skip ${name}: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      await p.close();
    }
  }

  for (const [target, source] of COPIES) {
    await page.request.get('http://localhost:9528/api/health').catch(() => {});
    const { copyFileSync } = await import('fs');
    try {
      copyFileSync(`../images/${source}`, `../images/${target}`);
    } catch {
      // 源文件缺失时跳过
    }
  }
});
