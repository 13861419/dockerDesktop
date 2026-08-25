# 移动端 / PWA · 实施设计（PRD + 技术方案）

> 生成日期：2026-08-24
> 视角：产品经理 + 架构师
> 对应头脑风暴文档：`docs/competitor-analysis-brainstorm.md` 第一梯队 #2
> 原则：**纯前端增强，不改架构、不加后端依赖**。采用**手写 Service Worker + manifest.json**（不引入 `vite-plugin-pwa`），与项目"零第三方依赖"哲学一致。目标：桌面/移动浏览器皆可安装、离线可开、移动端关键路径可用的 PWA。

---

## 一、背景与目标

现有 React WebApp（Vite + `@vitejs/plugin-react`，无 PWA 插件）在移动端可用但不"原生"。目标：

1. **可安装（Add to Home Screen）**：符合 PWA 安装条件（manifest + service worker + HTTPS/localhost）。
2. **离线缓存**：App Shell 静态资源缓存，断网也能打开面板外壳与已看过的数据。
3. **移动端关键路径适配**：总览监控、容器启停、告警确认、Webhook 触发在高分辨率/触摸屏上更顺手。
4. **推送（可选）**：预留 Web Push 接入（告警联动），本期不实现，留扩展位。

---

## 二、总体架构（纯前端）

```
web/public/
  ├─ manifest.webmanifest           # 图标 / 名称 / display:standalone / 主题色
  ├─ sw.js                          # Service Worker（缓存 App Shell + API 兜底回退）
  └─ icons/icon-192.png, icon-512.png, maskable.png   # 安装图标
web/index.html   加 <link rel="manifest"> + <link rel="apple-touch-icon"> + meta
web/src/main.tsx  注册 sw.js（仅 production）
web/src/styles/*.less  响应式断点 + 触控优化
vite.config.ts     无需改动（public/ 自动拷贝到 dist/）
```

- **静态托管**：Vite 默认把 `public/` 原样拷入 `web/dist`，后端 Express 已托管 `web/dist`，`/manifest.webmanifest`、`/sw.js`、`/icons/*` 直接可达，**无需配置改动**。
- **离线**：生产模式 SPA 路由由 Express 回退到 `index.html`；SW 缓存 `/`, `index.html`, 各 vendor chunk / async chunk（构建后哈希），实现离线打开。
- **API 不缓存**：业务数据走网络；SW 仅对 API 失败做「网络优先、失败时提示离线」的兜底（不缓存动态数据，避免过期告警/状态）。

---

## 三、Android / iOS 关键差异

| 项 | Chrome Android | iOS Safari |
|----|----------------|-----------|
| manifest | ✅ 标准支持 | 需 `<link rel="apple-touch-icon">` + `<meta name="apple-mobile-web-app-capable">` |
| 安装 | install prompt 自动 | 需手动"添加到主屏幕" |
| SW | ✅ | ✅（iOS 15.4+ HTTPS） |
| 图标 | 支持 maskable | 用 apple-touch-icon |
| 主题色 | theme_color | 用 `<meta name="theme-color">` |

**结论**：标准 manifest + apple 兼容 tag + 双份图标即可覆盖主流。

---

## 四、实施细节

### 4.1 `web/public/manifest.webmanifest`
```json
{
  "name": "Docker Manager",
  "short_name": "DockerMgr",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#1e1e2e",
  "theme_color": "#6366f1",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

### 4.2 `web/public/sw.js`
```js
const CACHE = 'dm-shell-v1';
const SHELL = ['/', '/index.html'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ),
  );
  self.clients.claim();
});
// 网络优先；静态资源失败回退缓存；API 失败提示离线
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                      // 不缓存写请求
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return; // 动态不缓存
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && url.origin === self.location.origin) {
          const clone = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/index.html')))
  );
});
```

### 4.3 `web/index.html` 追加
```html
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" href="/icons/icon-192.png" />
<meta name="theme-color" content="#6366f1" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
```

### 4.4 `web/src/main.tsx` 注册 SW（仅 production）
```ts
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 静默 */ });
  });
}
```

### 4.5 移动端样式与关键路径优化
- 在 `web/src/styles/` 加响应式断点（`@media (max-width: 768px)`）：顶栏折叠、表格横向滚动、按钮大触控热区（≥44px）、侧边栏抽屉化。
- 「总览」「容器」「告警」「Webhook 任务」四页优先做良好移动布局（其余页保证可滚动可读即可，避免一次改所有页面）。
- 用现有 `.less` BEM 保持风格，不引入新 UI 库。

### 4.6 图标
- 用 SVG → PNG 脚本或在线工具生成 192/512/maskable 三张（`web/public/icons/`）。可复用 README 中已有的容器 SVG 图形。

---

## 五、安全与合规

1. **离线不缓存敏感动态数据**：只缓存静态 App Shell；API/动态页走网络。
2. **SW 只处理 GET**：不拦截任何写请求；`/api`、`/ws` 排除，避免破坏 WebSocket/鉴权/流式。
3. **兼容降级**：SW 注册失败（非 HTTPS / 旧浏览器）时静默失败，不影响原功能。
4. **不使用远程依赖**：手写 SW/manifest，无第三方脚本。

---

## 六、任务拆分（可独立验收）

| # | 任务 | 涉及文件 | 验收 |
|---|------|----------|------|
| T1 | manifest + 图标 + index.html 兼容头 | 新建 `web/public/manifest.webmanifest`、`web/public/icons/*`、改 `web/index.html` | 浏览器识别为 PWA（Lighthouse installable 通过）；A2HS 可安装 |
| T2 | 手写 sw.js + main.tsx 注册 | 新建 `web/public/sw.js`、改 `web/src/main.tsx` | 生产构建后离线打开面板外壳可用；写请求不被拦截 |
| T3 | 移动端样式 & 关键路径（总览/容器/告警/任务） | 改 `web/src/styles/*.less`、相关页面 | 768px 下顶栏/表格/触摸热区适配；横向滚动正常 |
| T4 | 编译 + 构建 + 验证 | `vite.config.ts`（无需改，确认 public 拷贝） | `npm run build` 通过；`dist/` 含 manifest/sw/icons |
| T5 | 端到端验证 | 手测（Chrome/Lighthouse + iOS Safari）+ 现有回归 | 安装、离线打开、原功能零回归 |

**依赖顺序**：T1→T2→T4 ∥ T3 可并行；T5 收尾。

---

## 七、验证清单

1. Lighthouse PWA 审计：Installable / Offline 通过。
2. 手机添加到主屏幕 → 打开为 standalone 全屏应用。
3. 断网刷新 → App Shell + 已加载页面可离线打开；写操作（启停）在线恢复后正常。
4. `/api` 与 `/ws` 未被 SW 拦截，开发态代理与生产单进程托管均正常。
5. `npm run build` 通过；原有页面零回归。
