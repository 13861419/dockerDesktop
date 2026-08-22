/**
 * Playwright 前端全面功能测试
 *
 * 对 Docker 管理面板执行完整 CRUD 闭环功能测试（真实创建→验证→删除）：
 *  - 登录/鉴权
 *  - 容器管理（创建/重命名/删除）
 *  - 卷管理（创建/删除）
 *  - 网络管理（创建/删除）
 *  - 模板管理（新增/删除）
 *  - Compose 管理（新建弹窗）
 *  - 镜像管理
 *  - 系统设置
 *  - 其他页面关键交互
 *
 * 依赖：playwright-core，后端 localhost:9528，前端 localhost:9526
 * 用法：node scripts/e2e-functional-test.js
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

function resolveChromePath() {
  for (const c of CHROME_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ======================== 测试结果收集 ========================
const results = [];
let passed = 0;
let failed = 0;

function record(suite, name, ok, detail = '') {
  results.push({ suite, name, ok, detail });
  if (ok) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name} - ${detail}`);
  }
}

function section(title) {
  console.log(`\n---- ${title} ----`);
}

// ======================== 工具函数 ========================
async function getBodyText(page) {
  return await page.locator('body').innerText().catch(() => '');
}

async function hasText(page, text, timeout = 3000) {
  try {
    await page.locator(`text=${text}`).first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

// 可见弹窗定位器：匹配 Modal 根容器（class 恰为 modal），排除子元素（modal__header 等）。
// 不限定是否含输入框：创建表单（含 input）与删除确认框（仅按钮）都可定位，取最上层的 .last()
function visibleModal(page) {
  return page.locator('.modal:visible').last();
}

// 点击页面按文本匹配的按钮
async function clickButton(page, text) {
  const btn = page.locator(`button:has-text("${text}")`).first();
  await btn.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  if (await btn.count()) { await btn.click().catch(() => {}); return true; }
  return false;
}

// 点击弹窗内按文本匹配的按钮
async function clickInDialog(page, btnText) {
  const btn = visibleModal(page).locator(`button:has-text("${btnText}")`).first();
  await btn.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  if (await btn.count()) { await btn.click().catch(() => {}); return true; }
  return false;
}

// 弹窗内第 index 个 input 填值
async function fillModalInput(page, value, index = 0) {
  const inp = visibleModal(page).locator('input, textarea').nth(index);
  await inp.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  if (await inp.count()) { await inp.fill(value).catch(() => {}); return true; }
  return false;
}

// 关闭当前弹窗
async function closeDialog(page) {
  const ok = await clickInDialog(page, '取消');
  if (!ok) {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(300);
}

// 按名称删除某行资源并刷新验证：判断依据为刷新后名称消失（带轮询重试）
async function deleteRowByName(page, route, name) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const row = page.locator('tr').filter({ hasText: name }).first();
  const delBtn = row.locator('button:has-text("删除")').first();
  if (!(await delBtn.count())) return false;
  await delBtn.click().catch(() => {});
  await page.waitForTimeout(400);
  const confirmBtn = visibleModal(page).locator('button:has-text("删除")').first();
  if (await confirmBtn.count()) { await confirmBtn.click().catch(() => {}); }
  // 轮询：最多 6 次，每次刷新后检查名称是否消失
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1500);
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    if (!(await getBodyText(page)).includes(name)) return true;
  }
  return false;
}

// 卡片网格页（模板页）删除：按卡片文本定位，点卡片内的删除按钮
async function deleteCardByName(page, route, name) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const card = page.locator('.templates-card').filter({ hasText: name }).first();
  const delBtn = card.locator('button:has-text("删除")').first();
  if (!(await delBtn.count())) return false;
  await delBtn.click().catch(() => {});
  await page.waitForTimeout(400);
  const confirmBtn = visibleModal(page).locator('button:has-text("删除")').first();
  if (await confirmBtn.count()) { await confirmBtn.click().catch(() => {}); }
  // 轮询：最多 6 次，每次刷新后检查名称是否消失
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1500);
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    if (!(await getBodyText(page)).includes(name)) return true;
  }
  return false;
}

// ======================== 登录工具 ========================
async function login(page, user = LOGIN_USER, pass = LOGIN_PASSWORD) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  const allInputs = page.locator('input');
  if ((await allInputs.count()) >= 2) {
    await allInputs.nth(0).fill(user).catch(() => {});
    await allInputs.nth(1).fill(pass).catch(() => {});
  }
  const submit = page.locator('button[type="submit"], button:has-text("登录")').first();
  if (await submit.count()) {
    await submit.click().catch(() => page.keyboard.press('Enter'));
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(2500);
}

async function logout(page) {
  await page.evaluate(() => {
    try { localStorage.removeItem('docker_manager_token'); } catch {}
    try { localStorage.removeItem('docker_manager_role'); } catch {}
  });
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
}

// ======================== 主流程 ========================
async function run() {
  const chrome = resolveChromePath();
  if (!chrome) {
    console.error('未找到 Chrome，无法运行');
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();

  try {
    section('1. 登录/鉴权');
    await testLoginFlow(page);

    section('2. 容器管理');
    await testContainerFlow(page);

    section('3. 卷管理');
    await testVolumeFlow(page);

    section('4. 网络管理');
    await testNetworkFlow(page);

    section('5. 模板管理');
    await testTemplateFlow(page);

    section('6. Compose 管理');
    await testComposeFlow(page);

    section('7. 镜像管理');
    await testImageFlow(page);

    section('8. 系统设置');
    await testSettingsFlow(page);

    section('9. 其他页面');
    await testOtherPages(browser);
  } finally {
    await browser.close();
  }

  console.log('\n' + '='.repeat(64));
  console.log(`前端功能测试完成：共 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(64));

  if (failed > 0) {
    console.log('\n失败项：');
    results.filter((r) => !r.ok).forEach((r) => {
      console.log(`  [FAIL] [${r.suite}] ${r.name} - ${r.detail}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

// ======================== 1. 登录/鉴权 ========================
async function testLoginFlow(page) {
  await login(page);
  const notOnLogin = !page.url().includes('/login');
  record('登录', '正确凭证登录并跳转首页', notOnLogin, notOnLogin ? '' : `URL=${page.url()}`);

  const token = await page.evaluate(() => localStorage.getItem('docker_manager_token') || '');
  record('登录', 'Token 存入 localStorage', !!token && token.length > 10, token ? '' : 'Token 缺失');

  await logout(page);
  const allInputs = page.locator('input');
  await allInputs.nth(0).fill('').catch(() => {});
  await allInputs.nth(1).fill('').catch(() => {});
  const submit = page.locator('button[type="submit"], button:has-text("登录")').first();
  await submit.click().catch(() => {});
  await page.waitForTimeout(800);
  record('登录', '空凭证不跳转', page.url().includes('/login'), page.url().includes('/login') ? '' : '空凭证登录成功');

  await allInputs.nth(0).fill(LOGIN_USER).catch(() => {});
  await allInputs.nth(1).fill('wrong-password-xyz').catch(() => {});
  await submit.click().catch(() => {});
  await page.waitForTimeout(1500);
  const bodyErr = await getBodyText(page);
  const failHint = bodyErr.includes('失败') || bodyErr.includes('错误') || bodyErr.includes('密码');
  record('登录', '错误密码给出失败提示', failHint, failHint ? '' : '无提示');

  await login(page);
}

// ======================== 2. 容器管理 ========================
async function testContainerFlow(page) {
  const CNAME = 'dm-e2e-fn-container';

  await page.goto(`${BASE_URL}/containers`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  let body = await getBodyText(page);

  const hasTable = (await page.locator('table').count()) > 0;
  const isEmpty = body.includes('暂无容器') || body.includes('未找到匹配的容器');
  record('容器', '列表页加载', hasTable || isEmpty, (hasTable || isEmpty) ? '' : '无表格也无空态');

  const opened = await clickButton(page, '创建容器');
  if (opened) { await page.waitForTimeout(600); }
  const modalOpened = (await visibleModal(page).count()) > 0;
  record('容器', '打开创建弹窗', opened && modalOpened, !opened ? '无创建按钮' : modalOpened ? '' : '弹窗未出现');
  if (modalOpened) await closeDialog(page).catch(() => {});

  const search = page.locator('input[placeholder*="搜索"], input[placeholder*="search"]').first();
  if (await search.count()) {
    await search.fill('__nothing__').catch(() => {});
    await page.waitForTimeout(500);
    await search.fill('').catch(() => {});
    record('容器', '搜索框可输入', true);
  } else {
    record('容器', '搜索框可输入', false, '无搜索框');
  }

  // 创建容器
  let created = false;
  if (await clickButton(page, '创建容器')) {
    await page.waitForTimeout(600);
    await fillModalInput(page, CNAME, 0);
    const modal = visibleModal(page);
    const img = modal.locator('input[placeholder*="镜像"], input[placeholder*="image"]').first();
    if (await img.count()) { await img.fill('alpine:latest').catch(() => {}); }
    else {
      const allInp = modal.locator('input');
      if ((await allInp.count()) >= 2) { await allInp.nth(1).fill('alpine:latest').catch(() => {}); }
    }
    const ok = await clickInDialog(page, '创建');
    if (!ok) await clickInDialog(page, '确认');
    // 创建需拉取镜像，轮询刷新检测容器是否出现（最多 ~12s）
    created = false;
    await page.waitForTimeout(5000);
    await page.goto(`${BASE_URL}/containers`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(1800);
      body = await getBodyText(page);
      if (body.includes(CNAME)) { created = true; break; }
      await page.goto(`${BASE_URL}/containers`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    record('容器', '创建测试容器', created, created ? '' : `${CNAME} 未出现（可能镜像拉取失败或拉取超时）`);
  } else {
    record('容器', '创建测试容器', false, '无创建按钮');
  }

  if (created) {
    // 创建弹窗可能仍开着，先导航刷新
    await page.goto(`${BASE_URL}/containers`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // 重命名：确认按钮文本为「重命名」
    let renamed = false;
    const row = page.locator('tr').filter({ hasText: CNAME }).first();
    const renameBtn = row.locator('button:has-text("重命名")').first();
    if (await renameBtn.count()) {
      await renameBtn.click().catch(() => {});
      await page.waitForTimeout(500);
      await fillModalInput(page, 'dm-e2e-fn-renamed', 0).catch(() => {});
      await clickInDialog(page, '重命名').catch(() => {});
      // 刷新后检查
      await page.waitForTimeout(1200);
      await page.goto(`${BASE_URL}/containers`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      renamed = (await getBodyText(page)).includes('dm-e2e-fn-renamed');
      await closeDialog(page).catch(() => {});
    }
    record('容器', '重命名容器', renamed, renamed ? '' : '未出现新名称');

    // 删除（刷新后定位当前名称所在行）
    const targetName = renamed ? 'dm-e2e-fn-renamed' : CNAME;
    await page.goto(`${BASE_URL}/containers`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const row2 = page.locator('tr').filter({ hasText: targetName }).first();
    const delBtn = row2.locator('button:has-text("删除")').first();
    if (await delBtn.count()) {
      await delBtn.click().catch(() => {});
      await page.waitForTimeout(400);
      const confirmBtn = visibleModal(page).locator('button:has-text("删除")').first();
      if (await confirmBtn.count()) { await confirmBtn.click().catch(() => {}); }
      // 刷新后检查是否消失
      await page.waitForTimeout(2000);
      await page.goto(`${BASE_URL}/containers`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    const deleted = !(await getBodyText(page)).includes(targetName);
    record('容器', '删除测试容器', deleted, deleted ? '' : `仍存在 ${targetName}`);
  }
}

// ======================== 3. 卷管理 ========================
async function testVolumeFlow(page) {
  const VNAME = 'dm-e2e-fn-volume';
  await page.goto(`${BASE_URL}/volumes`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  let body = await getBodyText(page);
  record('卷', '列表页加载', body.includes('卷') || body.includes('Volume'), '无卷内容');

  let created = false;
  if (await clickButton(page, '新建卷')) {
    await page.waitForTimeout(500);
    await fillModalInput(page, VNAME, 0);
    const ok = await clickInDialog(page, '创建');
    if (!ok) await clickInDialog(page, '确认');
    await page.waitForTimeout(2000);
    body = await getBodyText(page);
    created = body.includes(VNAME);
    record('卷', '创建测试卷', created, created ? '' : `${VNAME} 未出现`);
  } else {
    record('卷', '创建测试卷', false, '无创建按钮');
  }

  if (created) {
    const deleted = await deleteRowByName(page, '/volumes', VNAME);
    record('卷', '删除测试卷', deleted, deleted ? '' : '卷仍存在');
  }
}

// ======================== 4. 网络管理 ========================
async function testNetworkFlow(page) {
  // 唯一名称避免历史残留冲突。注意：前端网络列表使用 dangling:false 过滤，
  // 新建的空网络通常不显示在列表，因此创建成功与否改用 docker CLI 验证。
  const { execSync } = require('child_process');
  const netExists = (name) => {
    try { return execSync(`docker network ls --format "{{.Name}}"`).toString().split('\n').includes(name); }
    catch { return false; }
  };
  const NNAME = 'dm-e2e-fn-net-' + Date.now().toString(36);
  await page.goto(`${BASE_URL}/networks`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  let body = await getBodyText(page);
  record('网络', '列表页加载', body.includes('网络') || body.includes('Network'), '无网络内容');

  let created = false;
  if (await clickButton(page, '新建网络')) {
    await page.waitForTimeout(500);
    await fillModalInput(page, NNAME, 0);
    const ok = await clickInDialog(page, '创建');
    if (!ok) await clickInDialog(page, '确认');
    // 轮询 docker CLI 确认网络创建成功（前端列表受 dangling 过滤可能不显示）
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1000);
      if (netExists(NNAME)) { created = true; break; }
    }
    record('网络', '创建测试网络', created, created ? '' : `${NNAME} 未创建成功`);
  } else {
    record('网络', '创建测试网络', false, '无创建按钮');
  }

  if (created) {
    // 尝试前端删除
    await page.goto(`${BASE_URL}/networks`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const row = page.locator('tr').filter({ hasText: NNAME }).first();
    const delBtn = row.locator('button:has-text("删除")').first();
    let frontDeleted = false;
    if (await delBtn.count()) {
      await delBtn.click().catch(() => {});
      await page.waitForTimeout(400);
      const confirmBtn = visibleModal(page).locator('button:has-text("删除")').first();
      if (await confirmBtn.count()) { await confirmBtn.click().catch(() => {}); }
      await page.waitForTimeout(1500);
      frontDeleted = !netExists(NNAME);
    }
    // 前端删除失败则用 docker CLI 兜底清理，避免残留
    if (!frontDeleted) {
      try { execSync(`docker network rm ${NNAME}`, { stdio: 'ignore' }); } catch {}
    }
    record('网络', '删除测试网络', frontDeleted, frontDeleted ? '' : '前端删除失败（已用 CLI 兜底清理）');
  }
}

// ======================== 5. 模板管理 ========================
async function testTemplateFlow(page) {
  const TNAME = 'dm-e2e-fn-template';
  await page.goto(`${BASE_URL}/templates`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  let body = await getBodyText(page);
  record('模板', '列表页加载', body.includes('模板') || body.includes('Template'), '无内容');

  let created = false;
  if (await clickButton(page, '新建模板')) {
    await page.waitForTimeout(500);
    await fillModalInput(page, TNAME, 0);
    const modal = visibleModal(page);
    const allInp = modal.locator('input');
    if ((await allInp.count()) >= 3) { await allInp.nth(2).fill('nginx:latest').catch(() => {}); }
    const ok = await clickInDialog(page, '创建');
    if (!ok) await clickInDialog(page, '保存');
    await page.waitForTimeout(2000);
    body = await getBodyText(page);
    created = body.includes(TNAME);
    record('模板', '新增测试模板', created, created ? '' : `${TNAME} 未出现`);
  } else {
    record('模板', '新增测试模板', false, '无新增按钮');
  }

  if (created) {
    const deleted = await deleteCardByName(page, '/templates', TNAME);
    record('模板', '删除测试模板', deleted, deleted ? '' : '模板仍存在');
  }
}

// ======================== 6. Compose 管理 ========================
async function testComposeFlow(page) {
  await page.goto(`${BASE_URL}/compose`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const body = await getBodyText(page);
  record('Compose', '列表页加载', body.includes('Compose') || body.includes('项目'), '无内容');

  const opened = await clickButton(page, '新建项目');
  if (opened) {
    await page.waitForTimeout(500);
    const modalOpened = (await visibleModal(page).count()) > 0;
    record('Compose', '新建弹窗可打开', modalOpened, modalOpened ? '' : '弹窗未出现');
    if (modalOpened) await closeDialog(page).catch(() => {});
  } else {
    record('Compose', '新建弹窗可打开', false, '无新建按钮');
  }
}

// ======================== 7. 镜像管理 ========================
async function testImageFlow(page) {
  await page.goto(`${BASE_URL}/images`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const tbl = (await page.locator('table').count()) > 0;
  const body = await getBodyText(page);
  record('镜像', '列表页加载', tbl || body.includes('暂无镜像'), (tbl || body.includes('暂无镜像')) ? '' : '无内容');
  const hasPull = body.includes('拉取') || body.includes('Pull');
  const hasPrune = body.includes('清理') || body.includes('Prune');
  record('镜像', '拉取/清理入口存在', hasPull || hasPrune, (hasPull || hasPrune) ? '' : '无拉取/清理入口');
}

// ======================== 8. 系统设置 ========================
async function testSettingsFlow(page) {
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const body = await getBodyText(page);
  record('设置', '页面加载', body.includes('设置') || body.includes('配置') || body.includes('Setting'), '无内容');
  record('设置', '用户/密码管理入口存在', body.includes('用户') || body.includes('密码'), (body.includes('用户') || body.includes('密码')) ? '' : '无用户管理');
}

// ======================== 9. 其他页面 ========================
const OTHER_PAGES = [
  { route: '/hub', markers: ['镜像源', '搜索'], name: '镜像仓库' },
  { route: '/events', markers: ['事件', 'Event'], name: 'Docker 事件' },
  { route: '/operation-logs', markers: ['操作', '日志'], name: '操作日志' },
  { route: '/notifications', markers: ['通知', '渠道'], name: '通知管理' },
  { route: '/hostfiles', markers: ['宿主机', '文件'], name: '宿主机文件' },
  { route: '/hostterminal', markers: ['终端'], name: '宿主机终端' },
  { route: '/sites', markers: ['站点', '网站'], name: '站点管理' },
  { route: '/engines', markers: ['引擎'], name: '引擎管理' },
  { route: '/tasks', markers: ['任务', '定时'], name: '计划任务' },
  { route: '/backups', markers: ['备份'], name: '备份管理' },
  { route: '/databases', markers: ['数据库', '实例'], name: '数据库管理' },
  { route: '/firewall', markers: ['防火墙'], name: '防火墙' },
  { route: '/health', markers: ['健康', '体检'], name: '健康体检' },
  { route: '/appstore', markers: ['应用', '商店'], name: '应用商店' },
  { route: '/swarm', markers: ['Swarm', '集群'], name: 'Swarm 集群' },
  { route: '/orchestrate', markers: ['编排', '依赖'], name: '容器编排' },
  { route: '/storage', markers: ['存储'], name: '存储管理' },
  { route: '/cloudbackup', markers: ['云备份', '云端'], name: '云备份' },
  { route: '/build', markers: ['构建'], name: '镜像构建' },
  { route: '/files', markers: ['文件'], name: '文件管理' },
];

async function testOtherPages(browser) {
  for (const p of OTHER_PAGES) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const pg = await ctx.newPage();
    try {
      await login(pg);
      await pg.goto(`${BASE_URL}${p.route}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await pg.waitForTimeout(2500);
      const body = await getBodyText(pg);
      const matched = p.markers.filter((m) => body.includes(m));
      record('其他', `${p.name} (${p.route})`, matched.length > 0, matched.length ? '' : `未找到 ${p.markers.join('/')}`);
    } catch {
      record('其他', `${p.name}`, false, '页面加载超时');
    } finally {
      await ctx.close().catch(() => {});
    }
  }
}

// 启动
run().catch((err) => {
  console.error('运行出错：', err);
  process.exit(1);
});
