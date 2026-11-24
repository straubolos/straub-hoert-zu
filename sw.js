// Service Worker: App-Dateien offline verfügbar machen.
// Bei jeder Veröffentlichung VERSION erhöhen, damit Geräte die neue Fassung laden.
const VERSION = '1.1.0';
const CACHE = `shz-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/audio.js',
  './js/db.js',
  './js/deepgram.js',
  './js/deepseek.js',
  './js/export.js',
  './js/http.js',
  './js/icons.js',
  './js/openai.js',
  './js/pipeline.js',
  './js/recorder.js',
  './js/settings.js',
  './js/summary.js',
  './js/util.js',
  './icons/icon.svg',
  './icons/favicon.ico',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shz-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Nur eigene Dateien – Anfragen an OpenAI laufen nie über den Cache.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Seite: erst Netz (für Updates), sonst Cache.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
