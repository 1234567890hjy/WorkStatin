import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

/**
 * 注册 Service Worker。
 *
 * 这不是可选项：Chrome 只把注册了 SW 的 PWA 列进系统分享面板，
 * 没有它 share_target（从短信分享导入）完全不工作。
 *
 * 只在生产构建注册：开发时 SW 会缓存旧资源，导致改代码不生效。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      console.warn('Service Worker 注册失败', e);
    });
  });
}
