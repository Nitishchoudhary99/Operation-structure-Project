/* SmartTrader service worker: makes the app installable and lets the app shell open offline.
   Business data (/api/*) is never cached: it always comes live from the server.
   Files are fetched from the network first so a new deploy shows up at once; the saved copy is used offline, and on a slow
   connection once the network has taken 0.8 s (the fresh copy is still saved for the next time). */
const CACHE = 'smarttrader-shell-v46';
const SHELL = ['/', '/boot.js', '/app.js', '/csv.js', '/i18n-hi.js', '/voice.js', '/escpos.js', '/app.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
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
    const key = req.mode === 'navigate' && url.pathname === '/' ? '/' : req;
    const saved = () => cache.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? cache.match('/') : null));
    // the network first, so a new deploy shows at once; but on a slow connection a saved copy is used after 0.8 s
    // (the answer still comes in behind and is saved for the next time), so the app opens without waiting
    const net = fetch(req);
    // the app shell is "/"; other pages (pricing, guides) are cached under their own address. Saved alongside (the copy is
    // taken before the page reads the answer); the worker stays up until it is saved, even after a saved copy was shown
    e.waitUntil(net.then((res) => (res.ok && res.type === 'basic' ? cache.put(key, res.clone()) : null)).catch(() => {}));
    const late = new Promise((done) => setTimeout(done, 800)).then(saved);
    try {
      const first = await Promise.race([net, late.then((r) => r || net)]);
      if (first) return first;
      return await net;
    } catch (err) {
      return (await saved()) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
