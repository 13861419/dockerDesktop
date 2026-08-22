/**
 * 全页面深度回归测试
 *
 * 对所有 31 个页面进行深度验证：
 *  1. 页面加载成功（无 JS 崩溃）
 *  2. 关键 UI 元素存在
 *  3. 无网络请求失败（4xx/5xx）
 *  4. 无控制台错误
 *  5. 页面内容标记验证
 *  6. API 响应状态码验证
 *
 * 依赖：playwright-core，后端运行在 localhost:9528，前端运行在 localhost:9526
 */
const fs = require('fs');
const { chromium } = require('playwright-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:9526';
const LOGIN_USER = process.env.LOGIN_USER || 'admin';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'admin888';
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function resolveChromePath() {
  for (const c of CHROME_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** 所有待测页面定义 */
const PAGES = [
  { name: 'overview', path: '/', markers: ['总览', '概览', 'Docker', '容器', '引擎'], title: '仪表盘总览' },
  { name: 'containers', path: '/containers', markers: ['容器', '创建容器'], title: '容器管理' },
  { name: 'images', path: '/images', markers: ['镜像', '拉取镜像'], title: '镜像管理' },
  { name: 'volumes', path: '/volumes', markers: ['卷', '创建卷'], title: '卷管理' },
  { name: 'networks', path: '/networks', markers: ['网络', '创建网络'], title: '网络管理' },
  { name: 'compose', path: '/compose', markers: ['Compose', '项目'], title: 'Compose 管理' },
  { name: 'templates', path: '/templates', markers: ['模板'], title: '容器模板' },
  { name: 'hub', path: '/hub', markers: ['镜像源', '搜索'], title: '镜像仓库' },
  { name: 'build', path: '/build', markers: ['构建'], title: '镜像构建' },
  { name: 'databases', path: '/databases', markers: ['数据库'], title: '数据库管理' },
  { name: 'sites', path: '/sites', markers: ['站点', '网站'], title: '站点管理' },
  { name: 'settings', path: '/settings', markers: ['设置', '配置'], title: '系统设置' },
  { name: 'engines', path: '/engines', markers: ['引擎', 'Docker'], title: '引擎信息' },
  { name: 'tasks', path: '/tasks', markers: ['任务', '定时'], title: '计划任务' },
  { name: 'backups', path: '/backups', markers: ['备份'], title: '备份管理' },
  { name: 'cloudbackup', path: '/cloudbackup', markers: ['云备份', '云端'], title: '云备份' },
  { name: 'firewall', path: '/firewall', markers: ['防火墙'], title: '防火墙' },
  { name: 'files', path: '/files', markers: ['文件'], title: '文件管理' },
  { name: 'hostfiles', path: '/hostfiles', markers: ['宿主机', '文件'], title: '宿主机文件' },
  { name: 'hostterminal', path: '/hostterminal', markers: ['终端', 'Terminal'], title: '宿主机终端' },
  { name: 'operationlogs', path: '/operation-logs', markers: ['操作日志', '日志', '操作', '审计'], title: '操作日志', skipFetchErrorCheck: true },
  { name: 'notifications', path: '/notifications', markers: ['通知', '渠道'], title: '通知管理' },
  { name: 'events', path: '/events', markers: ['事件', 'Event'], title: 'Docker 事件' },
  { name: 'storage', path: '/storage', markers: ['存储'], title: '存储管理' },
  { name: 'health', path: '/health', markers: ['健康', '体检'], title: '健康体检' },
  { name: 'swarm', path: '/swarm', markers: ['Swarm', '集群'], title: 'Swarm 集群' },
  { name: 'orchestrate', path: '/orchestrate', markers: ['编排', '依赖'], title: '容器编排' },
  { name: 'containerDetail', path: '/containerDetail/dummy', markers: ['容器'], title: '容器详情(不存在)', expectNotFound: true },
  { name: 'imageDetail', path: '/image/dummy', markers: ['镜像'], title: '镜像详情(不存在)', expectNotFound: true },
  { name: 'appstore', path: '/appstore', markers: ['应用', '商店', '安装'], title: '应用商店' },
  { name: 'login', path: '/login', markers: ['登录', '密码'], title: '登录页', noAuth: true },
];

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1000);
  const inputs = page.locator('input');
  if ((await inputs.count()) >= 2) {
    await inputs.nth(0).fill(LOGIN_USER);
    await inputs.nth(1).fill(LOGIN_PASSWORD);
  }
  const submit = page.locator('button[type="submit"], button:has-text("登录")').first();
  if (await submit.count()) {
    await submit.click().catch(async () => { await page.keyboard.press('Enter'); });
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(2000);
}

async function run() {
  const chrome = resolveChromePath();
  if (!chrome) {
    console.error('Chrome not found');
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // 登录
  await login(page);

  const results = [];

  for (const pg of PAGES) {
    const networkErrors = [];
    const consoleErrors = [];

    page.on('requestfailed', (req) => {
      networkErrors.push(`${req.method()} ${req.url()} ${req.failure()?.errorText || 'failed'}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && !res.url().includes('favicon')) {
        networkErrors.push(`${res.status()} ${res.url()}`);
      }
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    let ok = true;
    let detail = '';

    try {
      await page.goto(`${BASE_URL}${pg.path}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2500);

      const body = await page.locator('body').innerText().catch(() => '');

      // 检查页面标记
      const matched = pg.markers.filter((m) => body.includes(m));
      if (matched.length === 0 && !pg.expectNotFound) {
        detail = `未找到预期标记 [${pg.markers.join(', ')}]`;
        ok = false;
      }

      // 检查网络错误（忽略登录重定向等，以及预期 404 页面的 API 404）
      const realErrors = networkErrors.filter((e) => !e.includes('304') && !e.includes('401')
        && !(pg.expectNotFound && e.includes('404'))
      );
      if (realErrors.length > 0) {
        detail = `网络错误: ${realErrors[0]}`;
        ok = false;
      }

      // 检查控制台错误（忽略已知的非关键错误，以及预期 404 页面的 API 404）
      const realConsoleErrors = consoleErrors.filter((e) =>
        !e.includes('favicon') && !e.includes('WebSocket') && !e.includes('ResizeObserver')
        && !(pg.expectNotFound && e.includes('404'))
      );
      if (realConsoleErrors.length > 0) {
        detail = `控制台错误: ${realConsoleErrors[0].substring(0, 100)}`;
        ok = false;
      }

      // 检查是否有"拉取失败"或"加载失败"字样
      if (!pg.skipFetchErrorCheck && body.includes('拉取') && body.includes('失败') && !pg.expectNotFound) {
        detail = '页面显示拉取失败';
        ok = false;
      }

    } catch (err) {
      detail = `加载异常: ${err.message?.substring(0, 80)}`;
      ok = false;
    }

    results.push({ name: pg.name, title: pg.title, ok, detail });

    // 移除事件监听器（避免累积）
    page.removeAllListeners('requestfailed');
    page.removeAllListeners('response');
    page.removeAllListeners('console');
  }

  await browser.close();

  // 汇总
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log(`\n=== 全页面深度回归 ===`);
  console.log(`共 ${results.length} 项，通过 ${passed} 项，失败 ${failed.length} 项\n`);

  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.title} (${r.name})${r.ok ? '' : ` — ${r.detail}`}`);
  }

  if (failed.length > 0) {
    console.log('\n失败项:');
    for (const f of failed) {
      console.log(`  ❌ ${f.title}: ${f.detail}`);
    }
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
