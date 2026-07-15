// sw.js — Service Worker（Cache First 戦略）

const CACHE_NAME = 'kagee-v13';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/js/camera.js',
  '/js/classifier.js',
  '/js/poseExtractor.js',
  '/js/snapshot.js',
  '/js/artCanvas.js',
  '/js/game.js',
  '/js/ranking.js',
  '/js/effects.js',
  '/js/tutorial.js',
  '/js/zoo.js',
  '/js/zooUI.js',
  '/assets/hane.png',
  '/assets/sounds/great-dog.mp3',
  '/poses/poses.json',
  '/areas.json',
  '/assets/silhouettes/dog.jpg',
  '/assets/silhouettes/bird.jpg',
  '/assets/silhouettes/crab.jpg',
  '/assets/background/taitoru.jpg',
  '/assets/background/map.jpg',
];

// ─── install: 全アセットを事前キャッシュ ─────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: 'no-cache' でサーバーに再検証させ、
      // ブラウザHTTPキャッシュの古いファイルを取り込まないようにする
      cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: 'no-cache' })))
    )
  );
  self.skipWaiting();
});

// ─── activate: 古いキャッシュを削除 ──────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ─── fetch: Cache First → ネットワークフォールバック ─────────

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'error') {
          return response;
        }
        const toCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, toCache));
        return response;
      });
    })
  );
});
