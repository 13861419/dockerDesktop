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

async function inspectCompose(page) {
  const networkErrors = [];
  const consoleErrors = [];

  page.on('requestfailed', (request) => {
    // 单个项目 compose ps 失败时页面会容错，不判失败；仅记录
    if (!request.url().includes('compose')) {
      networkErrors.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().includes('/api/compose')) {
      networkErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  // Compose 页可能因逐个拉取项目状态而有持续请求，用 domcontentloaded + 等待
  await page.goto(`${BASE_URL}/compose`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const body = await page.locator('body').innerText();
  const shellMarkers = ['Compose 项目', '新建项目'];
  const matchedShell = shellMarkers.filter((marker) => body.includes(marker));
  const hasEmpty = body.includes('暂无 Compose 项目');
  const hasLoadFail = body.includes('拉取项目列表失败');
  const hasList = body.includes('已配置') || body.includes('未配置') || /Status|状态/.test(body);

  console.log('PAGE /compose');
  console.log(`TITLE ${await page.title()}`);
  console.log(`SHELL_MATCHED ${JSON.stringify(matchedShell)}`);
  console.log(`EMPTY_STATE ${hasEmpty}`);
  console.log(`LIST_PRESENT ${hasList}`);
  console.log(`LOAD_FAIL ${hasLoadFail}`);
  console.log(`NETWORK_ERRORS ${JSON.stringify(networkErrors)}`);
  console.log(`CONSOLE_ERRORS ${JSON.stringify(consoleErrors)}`);

  return { body, consoleErrors, hasLoadFail };
}

async function inspectNewProjectModal(page) {
  const createBtn = page.locator('button:has-text("新建项目")').first();
  console.log(`CREATE_BUTTON_COUNT ${await createBtn.count()}`);
  if (!(await createBtn.count())) return;

  await createBtn.click();
  await page.waitForTimeout(600);
  const modal = page.locator('.modal').first();
  const text = await modal.innerText().catch(() => '');
  const checks = ['项目名称', 'docker-compose.yml', '创建', '取消'];
  const results = checks.map((t) => text.includes(t));
  console.log(`CREATE_MODAL ${JSON.stringify(results)}`);

  const cancel = modal.locator('button:has-text("取消")').first();
  if (await cancel.count()) {
    await cancel.click().catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(300);
}

async function inspectConfigModal(page) {
  // 「配置」按钮在列表行操作区；若没有项目则不存在，跳过
  const configBtn = page.locator('button:has-text("配置")').first();
  console.log(`CONFIG_BUTTON_COUNT ${await configBtn.count()}`);
  if (!(await configBtn.count())) return;

  await configBtn.click();
  await page.waitForTimeout(800);
  const modal = page.locator('.modal').first();
  const text = await modal.innerText().catch(() => '');
  console.log(`CONFIG_MODAL_HAS_CONFIG_TITLE ${text.includes('配置')}`);

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
    const { consoleErrors, hasLoadFail } = await inspectCompose(page);

    const fatal = consoleErrors.filter(
      (err) => /Uncaught|Cannot read|undefined is not/.test(String(err))
    );
    if (fatal.length || hasLoadFail) {
      throw new Error(`Compose 页面存在致命错误: ${fatal.join(' | ') || '拉取项目列表失败'}`);
    }

    await inspectNewProjectModal(page);
    await inspectConfigModal(page);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
