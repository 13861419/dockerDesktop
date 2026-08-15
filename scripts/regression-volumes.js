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
 * 访问数据卷页面并采集页面、网络和控制台异常信息。
 */
async function inspectVolumes(page) {
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

  await page.goto(`${BASE_URL}/volumes`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const body = await page.locator('body').innerText();
  const markers = [
    '数据卷',
    '搜索卷名或挂载点',
    '刷新',
    '清理未使用卷',
    '新建卷',
    '暂无数据卷',
    '未找到匹配数据卷',
    '拉取数据卷列表失败',
  ];
  const matched = markers.filter((marker) => body.includes(marker));

  console.log('PAGE /volumes');
  console.log(`TITLE ${await page.title()}`);
  console.log(`MATCHED ${JSON.stringify(matched)}`);
  console.log(`NETWORK_ERRORS ${JSON.stringify(networkErrors)}`);
  console.log(`CONSOLE_ERRORS ${JSON.stringify(consoleErrors)}`);

  return { body, networkErrors, consoleErrors };
}

/**
 * 验证搜索空态不会触发页面错误。
 */
async function inspectSearch(page) {
  const search = page.locator('input[placeholder="搜索卷名或挂载点"]').first();
  const count = await search.count();
  console.log(`SEARCH_INPUT_COUNT ${count}`);
  if (count === 0) return;

  await search.fill('__regression_no_match__');
  await page.waitForTimeout(400);
  const body = await page.locator('body').innerText();
  console.log(`SEARCH_EMPTY_STATE ${body.includes('未找到匹配数据卷') || body.includes('暂无数据卷')}`);
  await search.fill('');
  await page.waitForTimeout(400);
}

/**
 * 尝试打开第一个数据卷的详情弹窗并验证内容。
 */
async function inspectDetail(page) {
  const detail = page.locator('button:has-text("详情")').first();
  const count = await detail.count();
  console.log(`DETAIL_BUTTON_COUNT ${count}`);
  if (count === 0) return;

  await detail.click();
  await page.waitForTimeout(900);
  const modal = page.locator('.modal').first();
  const modalText = await modal.innerText();
  const checks = ['卷详情', '名称', '驱动', '挂载点'];
  const results = checks.map((text) => modalText.includes(text));
  console.log(`DETAIL_MODAL ${JSON.stringify(results)}`);
  if (results.some((item) => !item)) {
    throw new Error('数据卷详情弹窗缺少关键内容');
  }

  const close = page.locator('.modal button:has-text("关闭"), .modal button:has-text("取消")').first();
  if (await close.count()) {
    await close.click().catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
}

/**
 * 执行数据卷页面回归检查。
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
    const { body, networkErrors, consoleErrors } = await inspectVolumes(page);
    if (networkErrors.length || consoleErrors.length || body.includes('拉取数据卷列表失败')) {
      throw new Error('数据卷页面存在加载、网络或控制台错误');
    }
    await inspectSearch(page);
    await inspectDetail(page);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
