/**
 * 容器详情页 (/containerDetail/:id) 浏览器回归脚本
 * 先通过后端 API 取一个真实容器 Id，再登录导航到详情页检查渲染，并收集网络/控制台错误。
 */
const fs = require('fs');
const { chromium } = require('playwright-core');

const API_URL = process.env.API_URL || 'http://localhost:9528';
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

/** 通过后端 API 登录并获取 token */
async function apiLogin() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: LOGIN_USER, password: LOGIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`后端登录失败: ${res.status}`);
  const data = await res.json();
  return data.token;
}

/** 获取第一个容器 Id（存在时） */
async function getFirstContainerId(token) {
  const res = await fetch(`${API_URL}/api/containers?all=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const list = await res.json();
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[0].Id || null;
}

/** 通过前端页面登录（用于建立浏览器侧会话） */
async function uiLogin(page) {
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
  const token = await apiLogin();
  const containerId = await getFirstContainerId(token);
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
    await uiLogin(page);
    const url = containerId ? `${BASE_URL}/containerDetail/${containerId}` : `${BASE_URL}/containerDetail/nonexistent`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const body = await page.locator('body').innerText();
    const shell = ['容器详情', '基本信息', '端口映射', '挂载卷', '网络', '环境变量', '返回容器列表'];
    const m = shell.filter((x) => body.includes(x));
    console.log(`PAGE /containerDetail/${containerId || 'nonexistent'}`);
    console.log(`CONTAINER_DETECTED ${!!containerId}`);
    console.log(`SHELL_MATCHED ${JSON.stringify(m)}`);
    console.log(`MISSING ${body.includes('未找到容器')}`);
    console.log(`NET ${JSON.stringify(net)}`);
    console.log(`CONSOLE ${JSON.stringify(cons)}`);
    if (m.length === 0) console.log(`BODY_HEAD ${JSON.stringify(body.slice(0, 300))}`);

    const fatal = cons.filter((e) => /Uncaught|Cannot read|undefined is not/.test(String(e)));
    if (fatal.length || body.includes('拉取容器详情失败')) {
      throw new Error(`容器详情页存在致命错误: ${fatal.join(' | ') || '拉取容器详情失败'}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
