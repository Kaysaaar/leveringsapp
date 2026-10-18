const CACHE_NAME = 'leveringsapp-v302';
const APP_SHELL = ['./', './index.html', './design.css', './drafts.js', './config.js', './home-data.js', './directory-demo.js', './manifest.json', './wallmann-logo.png', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(async cache => {
    // Fetch fresh files: do not fill a new cache with a stale HTTP-cached index.
    await cache.addAll(APP_SHELL.map(url => new Request(url, { cache:'reload' })));
  }));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Leave unrelated applications on the same GitHub Pages origin alone.
    await Promise.all(keys.filter(key => key.startsWith('leveringsapp-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const scope = new URL('./', self.location.href).href;
  if (!request.url.startsWith(scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try { return await fetch(request); }
    catch (error) {
      // HTML fallback belongs to navigations, never images, scripts or API requests.
      if (request.mode === 'navigate') { const shell = await cache.match('./index.html'); if (shell) return shell; }
      return Response.error();
    }
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});
