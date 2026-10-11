// Service worker - v2. Bump CACHE when files change (also bump ?v= in index.html).
const CACHE = 'walton-app-v6';
const SHELL = [
  './', './index.html', './app.js?v=6', './config.js?v=6', './redirect.html',
  './manifest.webmanifest', './lib/firebase.js', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-180.png', './icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: false }).then((hit) => hit || caches.match('./index.html')))
  );
});
