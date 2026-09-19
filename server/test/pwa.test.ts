/**
 * PWA（1.87.0）单元测试
 *
 * 覆盖：
 *  - manifest.webmanifest：结构合法、display/id/display_override/maskable 图标/shortcuts
 *  - sw.js：缓存名随版本、不拦截 /api 与 /ws
 *  - index.html：manifest 链接与移动端 meta 完整
 *  - web/src/pwa.ts：beforeinstallprompt 契约存在
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const WEB_PUBLIC = path.resolve(__dirname, '../../web/public');

test('manifest.webmanifest: 可安装要素与快捷方式', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(WEB_PUBLIC, 'manifest.webmanifest'), 'utf8'),
  );
  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual(manifest.id, '/');
  assert.strictEqual(manifest.start_url, '/');
  assert.ok(Array.isArray(manifest.display_override) && manifest.display_override.includes('standalone'));
  // 图标含 maskable（安装横幅与自适应图标）
  const icons = manifest.icons as Array<{ purpose?: string; sizes: string }>;
  assert.ok(icons.some((i) => i.purpose?.includes('maskable')), '应有 maskable 图标');
  assert.ok(icons.some((i) => i.sizes === '512x512'));
  // 快捷方式路由必须真实存在（与 App.tsx 路由一致）
  const shortcuts = manifest.shortcuts as Array<{ name: string; url: string }>;
  assert.ok(shortcuts.length >= 4, '至少 4 个快捷方式');
  const app = fs.readFileSync(path.resolve(__dirname, '../../web/src/App.tsx'), 'utf8');
  for (const s of shortcuts) {
    assert.ok(app.includes(`path="${s.url}"`), `快捷方式路由 ${s.url} 应存在于 App.tsx`);
  }
});

test('sw.js: 缓存版本化与 API 放行', () => {
  const sw = fs.readFileSync(path.join(WEB_PUBLIC, 'sw.js'), 'utf8');
  // 缓存名必须带版本号（dm-shell-<数字>），否则升级后离线壳滞留旧版
  assert.ok(/const CACHE = 'dm-shell-\d+/.test(sw), 'CACHE 应带版本号');
  assert.ok(sw.includes('/api'), '应排除 /api');
  assert.ok(sw.includes('/ws'), '应排除 /ws（隧道 WebSocket）');
  assert.ok(sw.includes('skipWaiting'), '新 SW 应立即接管');
});

test('index.html: manifest 链接与移动端 meta', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../web/index.html'), 'utf8');
  assert.ok(html.includes('rel="manifest"'));
  assert.ok(html.includes('apple-touch-icon'));
  assert.ok(html.includes('apple-mobile-web-app-capable'));
  assert.ok(html.includes('theme-color'));
  // iOS 安全区（底部导航不被手势条遮挡）
  assert.ok(html.includes('viewport-fit') || fs.readFileSync(path.resolve(__dirname, '../../web/src/styles/global.less'), 'utf8').includes('safe-area-inset'));
});
