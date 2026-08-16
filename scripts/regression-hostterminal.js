/**
 * 宿主机终端页 (/hostterminal) 浏览器回归脚本
 * 登录后导航到 /hostterminal，检查页面标题、shell 下拉与命令输入框是否正常渲染，并收集网络/控制台错误。
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

/** 解析可用的 Chrome 可执行文件路径 */
function resolveChromePath() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 登录面板 */
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
    await page.goto(`${BASE_URL}/hostterminal`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const body = await page.locator('body').innerText();
    const shell = ['宿主机终端', 'PowerShell', 'CMD', '当前目录', '刷新'];
    const m = shell.filter((x) => body.includes(x));
    console.log('PAGE /hostterminal');
    console.log(`SHELL_MATCHED ${JSON.stringify(m)}`);
    console.log(`READY ${body.includes('就绪') || body.includes('仅管理员可执行命令')}`);
    console.log(`NET ${JSON.stringify(net)}`);
    console.log(`CONSOLE ${JSON.stringify(cons)}`);
    if (m.length === 0) console.log(`BODY_HEAD ${JSON.stringify(body.slice(0, 300))}`);

    const fatal = cons.filter((e) => /Uncaught|Cannot read|undefined is not/.test(String(e)));
    if (fatal.length) {
      throw new Error(`宿主机终端页存在致命错误: ${fatal.join(' | ')}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
