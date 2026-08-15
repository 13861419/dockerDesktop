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

/**
 * 选择可用的本机 Chrome 可执行文件。
 */
function resolveChromePath() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 登录面板并填入默认凭据。
 */
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
    await submit.click().catch(async () => {
      await page.keyboard.press('Enter');
    });
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(1500);
}

/**
 * 访问数据库页面并采集页面、网络和控制台异常信息。
 */
async function inspectDatabases(page) {
  const networkErrors = [];
  const consoleErrors = [];

  page.on('requestfailed', (request) => {
    networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      networkErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(`${BASE_URL}/databases`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const body = await page.locator('body').innerText();
  const markers = [
    '数据库管理',
    '登记实例',
    '暂无数据库实例',
    '拉取数据库实例失败',
    'SQL 查询',
    'Redis',
  ];
  const matched = markers.filter((marker) => body.includes(marker));

  console.log('PAGE /databases');
  console.log(`TITLE ${await page.title()}`);
  console.log(`MATCHED ${JSON.stringify(matched)}`);
  console.log(`NETWORK_ERRORS ${JSON.stringify(networkErrors)}`);
  console.log(`CONSOLE_ERRORS ${JSON.stringify(consoleErrors)}`);

  return { body };
}

/**
 * 尝试打开数据库详情弹窗并验证关键区域可见。
 */
async function inspectDetailInteractions(page, body) {
  if (body.includes('暂无数据库实例')) {
    const registerButton = page.locator('button:has-text("登记实例")').first();
    const count = await registerButton.count();
    console.log(`REGISTER_BUTTON_COUNT ${count}`);
    if (count > 0) {
      await registerButton.click();
      await page.waitForTimeout(500);
      const modalBody = await page.locator('body').innerText();
      console.log(`REGISTER_MODAL ${JSON.stringify([
        modalBody.includes('登记实例'),
        modalBody.includes('名称'),
        modalBody.includes('类型'),
        modalBody.includes('主机'),
        modalBody.includes('端口'),
      ])}`);
      const close = page.locator('button:has-text("取消")').first();
      if (await close.count()) {
        await close.click().catch(() => {});
      }
    }
    return;
  }

  const detailButton = page.locator('button:has-text("详情")').first();
  const detailCount = await detailButton.count();
  console.log(`DETAIL_BUTTON_COUNT ${detailCount}`);
  if (detailCount > 0) {
    await detailButton.click();
    await page.waitForTimeout(700);
    const modalBody = await page.locator('body').innerText();
    console.log(`DETAIL_MODAL ${JSON.stringify([
      modalBody.includes('实例详情'),
      modalBody.includes('数据库 ('),
      modalBody.includes('SQL 查询'),
      modalBody.includes('键列表'),
    ])}`);
  }
}

/**
 * 执行数据库页面回归检查。
 */
async function main() {
  const executablePath = resolveChromePath();
  if (!executablePath) {
    throw new Error('未找到可用的 Chrome 可执行文件');
  }

  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  try {
    await login(page);
    const { body } = await inspectDatabases(page);
    await inspectDetailInteractions(page, body);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
