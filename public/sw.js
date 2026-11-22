const cacheName = 'fieldsync-shell-v1';
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data?.kind !== 'prime') return;
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(cacheName);
      const assets = event.data.assets.filter((asset) => {
        const url = new URL(asset, self.location.origin);
        return url.origin === self.location.origin && url.pathname.startsWith('/_next/static/');
      });
      await cache.addAll([...new Set(assets)]);
      // Publish a new shell only after its required assets are available.
      await cache.add('/');
      event.ports[0]?.postMessage(true);
    } catch {
      event.ports[0]?.postMessage(false);
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(fetch(request).catch(async () => (await caches.match('/')) || Response.error()));
  } else if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      const previous = await cache.match(request);
      if (previous) return previous;
      const result = await fetch(request);
      if (result.ok) await cache.put(request, result.clone());
      return result;
    })());
  }
});
