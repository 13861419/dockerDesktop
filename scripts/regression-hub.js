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
 * 访问镜像中心页并采集页面、网络与控制台异常信息。
 * Docker Hub 搜索在受限网络下可能失败，属优雅降级，不判失败。
 */
async function inspectHub(page) {
  const networkErrors = [];
  const consoleErrors = [];

  page.on('requestfailed', (request) => {
    networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 500) {
      // 记录所有 5xx（含搜索/镜像源接口）的具体 URL，用于定位降级来源
      networkErrors.push(`${status} ${url}`);
    } else if (status >= 400) {
      // 仅记录非搜索类 4xx；搜索/镜像源失败源于受限网络，不判失败
      if (!url.includes('/api/hub/search') && !url.includes('/api/hub/sources')) {
        networkErrors.push(`${status} ${url}`);
      }
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(`${BASE_URL}/hub`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const body = await page.locator('body').innerText();
  const shellMarkers = ['镜像中心', '常用镜像', '搜索 Docker Hub 镜像，如 nginx'];
  const commonImages = ['nginx', 'redis', 'mysql', 'postgres', 'alpine'];
  const matchedShell = shellMarkers.filter((marker) => body.includes(marker));
  const matchedCommon = commonImages.filter((name) => body.includes(name));

  console.log('PAGE /hub');
  console.log(`TITLE ${await page.title()}`);
  console.log(`SHELL_MATCHED ${JSON.stringify(matchedShell)}`);
  console.log(`COMMON_IMAGES ${JSON.stringify(matchedCommon)}`);
  console.log(`NETWORK_ERRORS ${JSON.stringify(networkErrors)}`);
  console.log(`CONSOLE_ERRORS ${JSON.stringify(consoleErrors)}`);

  return { body, networkErrors, consoleErrors };
}

/**
 * 观察首次自动搜索（进入页面默认搜索 nginx）结束后的页面状态。
 * 真实用户场景只触发这一次自动搜索，避免二次并发造成 state race 假象。
 */
async function inspectSearch(page) {
  const search = page.locator('input[placeholder="搜索 Docker Hub 镜像，如 nginx"]').first();
  console.log(`SEARCH_INPUT_COUNT ${await search.count()}`);

  // 等待首次自动搜索 settle（可能成功 / 空态 / 失败）
  await page.waitForTimeout(10000);

  const body = await page.locator('body').innerText();
  const repoCount = await page.locator('.hub-item').count();
  const skeletonCount = await page.locator('.skeleton').count();
  const outcome = {
    hasShell: body.includes('镜像中心') && body.includes('常用镜像'),
    repoCount,
    skeletonCount,
    hasEmpty: body.includes('未找到镜像'),
    hasErrorState: body.includes('搜索失败'),
  };
  console.log(`SEARCH_OUTCOME ${JSON.stringify(outcome)}`);

  if (!outcome.hasShell) {
    throw new Error('镜像中心页外壳缺失');
  }

  // 明确暴露缺陷：请求已失败/结束，但页面仍卡在骨架态，用户得不到任何反馈
  if (outcome.skeletonCount > 0 && outcome.repoCount === 0) {
    throw new Error(`搜索后仍卡在加载骨架态：skeletonCount=${outcome.skeletonCount}，未进入结果/空态/错误态`);
  }

  // 明确暴露缺陷：搜索失败（或空态）却仍残留过期结果列表
  if ((outcome.hasErrorState || outcome.hasEmpty) && outcome.repoCount > 0) {
    throw new Error(`搜索后状态异常：${outcome.hasErrorState ? '显示搜索失败' : '显示未找到镜像'}，但残留 ${outcome.repoCount} 条结果`);
  }
}

/**
 * 校验搜索结果为优雅降级而非控制台异常。
 */
function assertNoCrash(consoleErrors) {
  const fatal = consoleErrors.filter(
    (err) => /Uncaught|react|out of memory|Cannot read|undefined is not/.test(String(err))
  );
  if (fatal.length) {
    throw new Error(`镜像中心页存在致命控制台错误: ${fatal.join(' | ')}`);
  }
}

/**
 * 执行镜像中心页回归检查。
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
    const { body, networkErrors, consoleErrors } = await inspectHub(page);

    const shellOk = ['镜像中心', '常用镜像'].every((m) => body.includes(m));
    if (!shellOk) {
      throw new Error('镜像中心页外壳缺失');
    }
    assertNoCrash(consoleErrors);

    await inspectSearch(page);
    assertNoCrash(consoleErrors);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
