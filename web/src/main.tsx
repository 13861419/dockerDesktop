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
