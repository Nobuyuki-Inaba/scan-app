'use strict';

// アプリ一式をバージョン単位でキャッシュする（Cache-First）。
// リリース時に VERSION を変えると新しい SW として検出され、app.js が更新バナーを出す。
// ユーザーが「更新」を押すと SKIP_WAITING → activate で旧キャッシュを削除 → 再読み込み。
const VERSION    = '2026-10-20-7';
const CACHE_NAME = 'scan-app-' + VERSION;

// index.html は './' で持つ（/index.html は Cloudflare が / へリダイレクトするため、
// リダイレクト応答をナビゲーションに返すと Safari がエラーにする）
const APP_SHELL = [
  './',
  'css/style.css',
  'js/app.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'vendor/papaparse.min.js',
  'vendor/zxing-reader.js',
  'vendor/zxing_reader.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // HTTP キャッシュを通さず必ずサーバーから取る（古いファイルが混ざらないように）
      cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // CSV の URL 取得など外部へのリクエストには関与しない
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(caches.match('./').then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req))
  );
});
