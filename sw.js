// Service worker - v2. Bump CACHE when files change (also bump ?v= in index.html).
const CACHE = 'walton-lists-v7';
const SHELL = [
  './', './index.html', './app.js?v=7', './config.js?v=7', './redirect.html',
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

// Show a notification when a push arrives (app open or closed).
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (err) { try { data = { body: e.data.text() }; } catch (e2) { data = {}; } }
  const title = data.title || 'Walton Lists';
  const opts = {
    body: data.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: data.tag || 'walton-lists',
    renotify: true,
    data: { url: data.url || './' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// Open/focus the app (on the right list) when a notification is tapped.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        try { await c.navigate(target); } catch (err) { /* cross-state navigate can fail; just focus */ }
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
