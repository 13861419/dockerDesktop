/**
 * 应用入口
 *
 * 引入全局样式并挂载根组件。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.less';

// 挂载 React 应用
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// PWA：生产模式注册 Service Worker（离线缓存 App Shell）；失败静默降级
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // 静默：非 HTTPS 或旧浏览器忽略
    });
    // 新 Service Worker 激活接管后刷新一次，避免新旧 App Shell 混跑（1.87.0）
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}
