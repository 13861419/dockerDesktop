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

async function collectErrors(page, errors) {
  page.on('requestfailed', (request) => {
    errors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
}

async function main() {
  const executablePath = resolveChromePath();
  if (!executablePath) throw new Error('未找到可用的 Chrome 可执行文件');
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  const net = [];
  const cons = [];
  const errBag = net;
  errBag.console = cons;
  try {
    await login(page);
    await collectErrors(page, errBag);

    await page.goto(`${BASE_URL}/sites`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const body = await page.locator('body').innerText();
    const shell = ['站点', '/ 反向代理', '新增站点', '域名', '状态'];
    const m = shell.filter((x) => body.includes(x));
    console.log('PAGE /sites');
    console.log(`SHELL_MATCHED ${JSON.stringify(m)}`);
    console.log(`EMPTY ${body.includes('暂无站点')}`);
    console.log(`NET ${JSON.stringify(net)}`);
    console.log(`CONSOLE ${JSON.stringify(cons)}`);
    if (m.length === 0) {
      console.log(`BODY_HEAD ${JSON.stringify(body.slice(0, 300))}`);
    }

    const fatal = cons.filter((e) => /Uncaught|Cannot read|undefined is not/.test(String(e)));
    if (fatal.length || body.includes('加载站点失败')) {
      throw new Error(`站点页存在致命错误: ${fatal.join(' | ') || '加载站点失败'}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
