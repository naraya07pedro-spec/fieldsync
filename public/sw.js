const cacheName = 'fieldsync-shell-v1';
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data?.kind !== 'prime') return;
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(cacheName);
      const shell = await fetch('/', { cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (!shell.ok || !shell.headers.get('content-type')?.includes('text/html')) throw new Error('Shell unavailable');
      const html = await shell.clone().text();
      const assets = new Set();
      for (const [, path] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const url = new URL(path.replaceAll('&amp;', '&'), self.location.origin);
        if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')) assets.add(url.href);
      }
      if (!assets.size) throw new Error('Shell assets missing');
      await cache.addAll([...assets].map((url) => new Request(url, { credentials: 'omit', redirect: 'error' })));
      // Use the same HTML response used to discover the assets for this build.
      await cache.put('/', shell);
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
    event.respondWith((async () => {
      const response = await fetch(request, { signal: AbortSignal.timeout(8000) }).catch(() => undefined);
      if (response && response.status < 500) return response;
      const shell = await caches.match('/', { cacheName }).catch(() => undefined);
      return shell || response || Response.error();
    })());
  } else if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith((async () => {
      const cache = await caches.open(cacheName).catch(() => undefined);
      const previous = await cache?.match(request).catch(() => undefined);
      if (previous) return previous;
      const result = await fetch(request);
      if (result.ok) await cache?.put(request, result.clone()).catch(() => {});
      return result;
    })());
  }
});
