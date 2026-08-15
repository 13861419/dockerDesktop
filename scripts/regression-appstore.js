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
 * 访问应用商店页面并采集页面、网络和控制台异常信息。
 */
async function inspectAppStore(page) {
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

  await page.goto(`${BASE_URL}/appstore`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const body = await page.locator('body').innerText();
  const markers = [
    '应用商店',
    '搜索应用名称或描述',
    '全部分类',
    '全部应用',
    '已安装',
    '详情',
    '安装',
    '拉取应用商店失败',
  ];
  const matched = markers.filter((marker) => body.includes(marker));

  console.log('PAGE /appstore');
  console.log(`TITLE ${await page.title()}`);
  console.log(`MATCHED ${JSON.stringify(matched)}`);
  console.log(`NETWORK_ERRORS ${JSON.stringify(networkErrors)}`);
  console.log(`CONSOLE_ERRORS ${JSON.stringify(consoleErrors)}`);

  return { body, networkErrors, consoleErrors };
}

/**
 * 验证搜索框不会导致页面崩溃或错误空态丢失。
 */
async function inspectSearch(page) {
  const search = page.locator('input[placeholder="搜索应用名称或描述"]').first();
  const count = await search.count();
  console.log(`SEARCH_INPUT_COUNT ${count}`);
  if (count === 0) return;

  await search.fill('__regression_no_match__');
  await page.waitForTimeout(400);
  const body = await page.locator('body').innerText();
  console.log(`SEARCH_EMPTY_STATE ${body.includes('未找到匹配应用')}`);
  await search.fill('');
  await page.waitForTimeout(400);
}

/**
 * 打开详情弹窗并验证详情内容区域可见。
 */
async function inspectDetailModal(page) {
  const detail = page.locator('button:has-text("详情")').first();
  const count = await detail.count();
  console.log(`DETAIL_BUTTON_COUNT ${count}`);
  if (count === 0) return false;

  await detail.click();
  await page.waitForTimeout(500);
  const body = await page.locator('body').innerText();
  console.log(`DETAIL_MODAL ${JSON.stringify([
    body.includes('镜像'),
    body.includes('版本') || body.includes('状态') || body.includes('端口') || body.includes('服务列表'),
  ])}`);

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  return true;
}

/**
 * 打开安装配置弹窗并验证配置区域可见但不提交安装。
 */
async function inspectInstallModal(page) {
  const install = page.locator('.appstore-card__actions button:has-text("安装")').first();
  const count = await install.count();
  console.log(`INSTALL_BUTTON_COUNT ${count}`);
  if (count === 0) return;

  await install.click();
  await page.waitForTimeout(700);
  const modal = page.locator('.modal').first();
  const modalText = await modal.innerText();
  const checks = [
    modalText.includes('确认安装'),
    modalText.includes('镜像源'),
    modalText.includes('端口映射') || modalText.includes('环境变量') || modalText.includes('默认配置安装'),
  ];
  console.log(`INSTALL_MODAL ${JSON.stringify(checks)}`);
  if (checks.some((item) => !item)) {
    throw new Error('应用安装配置弹窗缺少关键内容');
  }

  const cancel = modal.locator('button:has-text("取消")').first();
  if (await cancel.count()) {
    await cancel.click().catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
}

/**
 * 执行应用商店页面回归检查。
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
    const { body, networkErrors, consoleErrors } = await inspectAppStore(page);
    if (networkErrors.length || consoleErrors.length || body.includes('拉取应用商店失败')) {
      throw new Error('应用商店页面存在加载、网络或控制台错误');
    }
    await inspectSearch(page);
    const hasDetail = await inspectDetailModal(page);
    if (hasDetail) {
      await inspectInstallModal(page);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
