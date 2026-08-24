/**
 * 截取 9 个新功能页面的截图（用于补充手册截图）
 *
 * 依赖：playwright-core，后端 localhost:9528，前端 localhost:9526，本机 Chrome
 * 用法：node scripts/screenshot-new-features.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:9526';
const LOGIN_USER = process.env.LOGIN_USER || 'admin';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'admin888';
const OUT_DIR = path.resolve(__dirname, '../docs/images');

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

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
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
  await page.waitForTimeout(2500);
  return !page.url().includes('/login');
}

// 截图任务列表
const SHOTS = [
  {
    file: 'vuln-scan.png',
    route: '/images',
    wait: 2500,
    note: '镜像列表页（漏洞扫描入口）',
  },
  {
    file: 'cross-engine-migration.png',
    route: '/engines',
    wait: 2500,
    note: 'Docker 引擎页（跨引擎迁移入口）',
  },
  {
    file: 'cross-engine-overview.png',
    route: '/',
    wait: 2500,
    note: '总览页（多引擎聚合）',
  },
  {
    file: 'global-search.png',
    route: '/',
    wait: 2000,
    note: '总览页（含顶部全局搜索框）',
  },
  {
    file: 'resource-dashboard.png',
    route: '/',
    wait: 2500,
    note: '总览页资源占用看板',
  },
  {
    file: 'monitoring-history.png',
    route: '/health',
    wait: 2500,
    note: '健康体检/监控历史页',
  },
  {
    file: 'hub-enhanced.png',
    route: '/hub',
    wait: 2500,
    note: '镜像中心页',
  },
  {
    file: 'config-import-export.png',
    route: '/settings',
    wait: 2500,
    note: '系统设置页（配置导入导出）',
  },
  {
    file: 'webhook-git-deploy.png',
    route: '/tasks',
    wait: 2500,
    note: '计划任务页（Webhook/Git 部署）',
  },
];

async function run() {
  const chrome = resolveChromePath();
  if (!chrome) {
    console.error('Chrome not found');
    process.exit(1);
  }
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  console.log('登录...');
  const ok = await login(page);
  if (!ok) {
    console.error('登录失败');
    await browser.close();
    process.exit(1);
  }
  console.log('登录成功');

  for (const s of SHOTS) {
    await page.goto(`${BASE_URL}${s.route}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(s.wait);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const textLen = bodyText.replace(/\s+/g, ' ').trim().length;
    const outPath = path.join(OUT_DIR, s.file);
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`[OK] ${s.file}  <-  ${s.route}  (${s.note})  文本长度=${textLen}`);
    if (textLen < 20) {
      console.warn(`  警告: ${s.file} 页面文本过短，可能未正常渲染`);
    }
  }

  await browser.close();
  console.log('全部截图完成');
}

run().catch((e) => { console.error(e); process.exit(1); });
