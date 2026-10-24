/**
 * Service Worker。
 *
 * 存在两个不可替代的作用：
 * 1. **share_target 的前提**：Chrome 只把注册了 SW 的 PWA 列进系统分享面板。
 *    没有这个文件，「从短信分享导入」功能整个不存在。
 * 2. **离线壳**：网络差时至少能打开界面（数据请求仍走网络，不做离线写入）。
 *
 * 刻意保持极简：不引入 Workbox，不做复杂预缓存清单 ——
 * 单人自用，缓存策略越简单越不容易出诡异的「更新不生效」问题。
 */

const CACHE = 'ws-shell-v2';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理 GET；API 请求一律走网络，绝不缓存（记账数据不能看到旧的）
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;

  // 导航请求：网络优先，失败回退到缓存的壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r ?? Response.error())),
    );
    return;
  }

  // 静态资源：缓存优先，后台更新
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
