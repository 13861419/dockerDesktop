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
 * 访问容器列表页并采集页面、网络与控制台异常信息。
 */
async function inspectContainers(page) {
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

  // 容器页每 3 秒轮询一次统计，networkidle 无法达成；改用 load 等待 DOM 就绪后再等待数据渲染
  await page.goto(`${BASE_URL}/containers`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const body = await page.locator('body').innerText();
  const shellMarkers = ['容器', '搜索 容器名 / 镜像 / ID', '共', '创建容器', '清理未使用', '全部镜像'];
  const matchedShell = shellMarkers.filter((marker) => body.includes(marker));
  const hasEmptyState = body.includes('暂无容器') || body.includes('未找到匹配的容器');
  const hasFail = body.includes('拉取容器列表失败');

  console.log('PAGE /containers');
  console.log(`TITLE ${await page.title()}`);
  console.log(`SHELL_MATCHED ${JSON.stringify(matchedShell)}`);
  console.log(`EMPTY_STATE ${hasEmptyState}`);
  console.log(`LOAD_FAIL ${hasFail}`);
  console.log(`NETWORK_ERRORS ${JSON.stringify(networkErrors)}`);
  console.log(`CONSOLE_ERRORS ${JSON.stringify(consoleErrors)}`);

  return { body, networkErrors, consoleErrors };
}

/**
 * 验证搜索空态与状态筛选均为非破坏性交互且不报错。
 */
async function inspectInteractions(page) {
  // 1. 搜索空态
  const search = page.locator('input[placeholder="搜索 容器名 / 镜像 / ID"]').first();
  const scount = await search.count();
  console.log(`SEARCH_INPUT_COUNT ${scount}`);
  if (scount > 0) {
    await search.fill('__regression_no_match_container__');
    await page.waitForTimeout(400);
    const b1 = await page.locator('body').innerText();
    console.log(`SEARCH_EMPTY_STATE ${b1.includes('未找到匹配的容器') || b1.includes('暂无容器')}`);
    await search.fill('');
    await page.waitForTimeout(300);
  }

  // 2. 状态筛选「运行中」：仅切换 filter，不触发容器操作（页面仅有 全部/运行中 两个筛选）
  const running = page.locator('button:has-text("运行中")').first();
  if (await running.count()) {
    await running.click();
    await page.waitForTimeout(400);
    const b2 = await page.locator('body').innerText();
    console.log(`RUNNING_FILTER_OK ${(b2.includes('运行中') || b2.includes('暂无') || b2.includes('共')) && !b2.includes('拉取容器列表失败')}`);
  } else {
    console.log('RUNNING_FILTER_NOT_FOUND');
  }

  // 3. 回到「全部」筛选
  const all = page.locator('button:has-text("全部")').first();
  if (await all.count()) {
    await all.click();
    await page.waitForTimeout(300);
  }
}

/**
 * 执行容器列表页回归检查。
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
    const { body, networkErrors, consoleErrors } = await inspectContainers(page);

    if (networkErrors.length || consoleErrors.length || body.includes('拉取容器列表失败')) {
      throw new Error('容器页面存在加载、网络或控制台错误');
    }

    await inspectInteractions(page);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
