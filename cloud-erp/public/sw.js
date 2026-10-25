/* SmartTrader service worker: makes the app installable and lets the app shell open offline.
   Business data (/api/*) is never cached: it always comes live from the server.
   Files are fetched from the network first so a new deploy shows up at once; the saved copy is only used offline. */
const CACHE = 'smarttrader-shell-v12';
const SHELL = ['/', '/app.js', '/csv.js', '/app.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
  '/vendor/qrcode.mjs', '/vendor/JsBarcode.all.min.js', '/vendor/html-to-image.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      // the app shell is "/"; other pages (pricing, guides) are cached under their own address
      if (res.ok && res.type === 'basic') cache.put(req.mode === 'navigate' && url.pathname === '/' ? '/' : req, res.clone());
      return res;
    } catch (err) {
      return (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('/') : null) ||
        new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
