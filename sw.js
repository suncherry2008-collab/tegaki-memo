// オフライン用のキャッシュ。
// 仕組み: キャッシュがあれば即座にそれを返し、裏で最新版を取得して次回起動時に反映する。
// アプリを更新して配信したら CACHE の番号を上げると、確実に新しい版へ切り替わる。

const CACHE = 'tegaki-memo-v1';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'db.js',
  'editor.js',
  'render.js',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(req)
      .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; })
      .catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }
    return (await fresh) || new Response('オフラインのため読み込めません', { status: 503 });
  })());
});
