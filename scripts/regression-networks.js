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
    await submit.click().catch(async () => {
      await page.keyboard.press('Enter');
    });
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(1500);
}

async function inspectNetworks(page) {
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

  await page.goto(`${BASE_URL}/networks`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const body = await page.locator('body').innerText();
  const shellMarkers = ['网络', '新建网络', '清理未使用网络', '刷新'];
  const matchedShell = shellMarkers.filter((marker) => body.includes(marker));
  const hasEmpty = body.includes('暂无网络');
  const hasLoadFail = body.includes('拉取网络列表失败');

  console.log('PAGE /networks');
  console.log(`TITLE ${await page.title()}`);
  console.log(`SHELL_MATCHED ${JSON.stringify(matchedShell)}`);
  console.log(`EMPTY_STATE ${hasEmpty}`);
  console.log(`LOAD_FAIL ${hasLoadFail}`);
  console.log(`NETWORK_ERRORS ${JSON.stringify(networkErrors)}`);
  console.log(`CONSOLE_ERRORS ${JSON.stringify(consoleErrors)}`);

  return { body, consoleErrors, hasLoadFail };
}

async function inspectDetailModal(page) {
  // 若有网络行，打开详情弹窗（只读）验证后关闭；不点击连接/断开等操作
  const detailBtn = page.locator('button:has-text("详情")').first();
  console.log(`DETAIL_BUTTON_COUNT ${await detailBtn.count()}`);
  if (!(await detailBtn.count())) return;

  await detailBtn.click();
  await page.waitForTimeout(800);
  const modal = page.locator('.modal').first();
  const text = await modal.innerText().catch(() => '');
  const hasNetworkTitle = text.includes('网络') || text.includes('详情') || text.includes('容器');
  const hasInspect = text.includes('Name') || text.includes('Driver') || text.includes('Subnet') || text.includes('IPAM');
  console.log(`DETAIL_MODAL_NETWORK_TITLE ${hasNetworkTitle}`);
  console.log(`DETAIL_MODAL_HAS_INSPECT ${hasInspect}`);

  const close = modal.locator('button:has-text("关闭")').first();
  if (await close.count()) {
    await close.click().catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(300);
}

async function main() {
  const executablePath = resolveChromePath();
  if (!executablePath) {
    throw new Error('未找到可用的 Chrome 可执行文件');
  }

  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  try {
    await login(page);
    const { consoleErrors, hasLoadFail } = await inspectNetworks(page);

    const fatal = consoleErrors.filter(
      (err) => /Uncaught|Cannot read|undefined is not/.test(String(err))
    );
    if (fatal.length || hasLoadFail) {
      throw new Error(`网络页面存在致命错误: ${fatal.join(' | ') || '拉取网络列表失败'}`);
    }

    await inspectDetailModal(page);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
