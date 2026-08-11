const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:9546/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const inputs = page.locator('input');
  await inputs.nth(0).fill('admin');
  await inputs.nth(1).fill('admin888');
  await page.locator('button[type="submit"], button:has-text("登录")').first().click().catch(() => page.keyboard.press('Enter'));
  await page.waitForTimeout(1200);
  await page.goto('http://localhost:9546/images', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const body = await page.locator('body').innerText();
  console.log('镜像页含"大小":', body.includes('大小'));
  console.log('含排序箭头初始(空):', !/大小 ↑/.test(body) || !/大小 ↓/.test(body));
  // 点击"大小"表头排序
  const thSize = page.locator('th.th-sort', { hasText: '大小' }).first();
  const cnt = await thSize.count();
  console.log('可点击"大小"表头数(期望>=1):', cnt);
  if (cnt > 0) {
    await thSize.click(); await page.waitForTimeout(500);
    const b2 = await page.locator('body').innerText();
    console.log('点击后显示"大小 ↓":', /大小 ↓/.test(b2));
  }
  await browser.close();
  console.log('DONE');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
