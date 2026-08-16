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
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const inputs = page.locator('input');
  if ((await inputs.count()) >= 2) {
    await inputs.nth(0).fill(LOGIN_USER);
    await inputs.nth(1).fill(LOGIN_PASSWORD);
  } else {
    throw new Error('login page did not expose at least two input fields');
  }
  const submit = page.locator('button[type="submit"], button:has-text("登录")').first();
  if (await submit.count()) {
    await submit.click().catch(async () => { await page.keyboard.press('Enter'); });
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(1500);
}

async function main() {
  const executablePath = resolveChromePath();
  if (!executablePath) throw new Error('未找到可用的 Chrome 可执行文件');
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  const net = [];
  const cons = [];
  page.on('requestfailed', (r) => net.push(`${r.method()} ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) net.push(`${r.status()} ${r.url()}`); });
  page.on('console', (m) => { if (m.type() === 'error') cons.push(m.text()); });

  try {
    await login(page);
    await page.goto(`${BASE_URL}/storage`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText();
    const shell = ['磁盘使用统计', '磁盘分区使用率', '清理', '一键清理'];
    console.log('PAGE /storage');
    console.log(`SHELL_MATCHED ${JSON.stringify(shell.filter((m) => body.includes(m)))}`);
    console.log(`HAS_STATS ${body.includes('镜像') && body.includes('容器') && body.includes('数据卷')}`);
    console.log(`LOAD_FAIL ${body.includes('无法获取磁盘统计') || body.includes('加载磁盘统计失败')}`);
    console.log(`NET ${JSON.stringify(net)}`);
    console.log(`CONSOLE ${JSON.stringify(cons)}`);

    const fatal = cons.filter((e) => /Uncaught|Cannot read|undefined is not/.test(String(e)));
    if (fatal.length || body.includes('无法获取磁盘统计')) {
      throw new Error(`存储页存在致命错误: ${fatal.join(' | ') || '无法获取磁盘统计'}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
