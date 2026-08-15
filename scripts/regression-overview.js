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
 * 访问总览页并采集页面、网络和控制台异常信息。
 */
async function inspectOverview(page) {
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

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);

  const body = await page.locator('body').innerText();
  const statMarkers = ['容器总数', '运行中', '已停止', '镜像', '数据卷', '网络'];
  const engineMarkers = ['引擎名称', '版本', '操作系统', '架构', '内存'];
  const monitorMarkers = ['资源监控', 'CPU', '内存', '磁盘', '容器', '镜像', '资源占用正常'];
  const matchedStats = statMarkers.filter((marker) => body.includes(marker));
  const matchedEngine = engineMarkers.filter((marker) => body.includes(marker));
  const matchedMonitor = monitorMarkers.filter((marker) => body.includes(marker));

  console.log('PAGE /');
  console.log(`TITLE ${await page.title()}`);
  console.log(`STAT_MATCHED ${JSON.stringify(matchedStats)}`);
  console.log(`ENGINE_MATCHED ${JSON.stringify(matchedEngine)}`);
  console.log(`MONITOR_MATCHED ${JSON.stringify(matchedMonitor)}`);
  console.log(`NETWORK_ERRORS ${JSON.stringify(networkErrors)}`);
  console.log(`CONSOLE_ERRORS ${JSON.stringify(consoleErrors)}`);

  return { body, networkErrors, consoleErrors };
}

/**
 * 在多个监控轮询周期后确认页面仍稳定且无错误。
 */
async function awaitPollStability(page, networkErrors, consoleErrors) {
  await page.waitForTimeout(2600);
  const body = await page.locator('body').innerText();
  console.log(`POLL_STABLE ${JSON.stringify({
    hasTitle: body.includes('总览'),
    hasMonitor: body.includes('资源监控'),
    networkErrors: networkErrors.length,
    consoleErrors: consoleErrors.length,
  })}`);
}

/**
 * 执行总览页回归检查。
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
    const { body, networkErrors, consoleErrors } = await inspectOverview(page);
    await awaitPollStability(page, networkErrors, consoleErrors);

    if (
      networkErrors.length ||
      consoleErrors.length ||
      body.includes('加载失败') ||
      body.includes('重试')
    ) {
      throw new Error('总览页存在加载、网络或控制台错误');
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
