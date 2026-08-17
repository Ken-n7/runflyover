// Run Flyover service worker.
//
// Two tiers, on purpose:
//   SHELL   — the app itself and the libraries it cannot start without.
//             Precached on install, so a cold offline launch works.
//   RUNTIME — third-party assets fetched on demand (fonts, the FIT decoder,
//             the map style). Cache-first once seen; all are versioned or
//             immutable, so staleness is not a risk.
//
// Map *tiles* are deliberately NOT cached here. A world basemap has no bound,
// and the browser's own HTTP cache already holds them (OpenFreeMap and CARTO
// send long max-age), which covers revisiting an area offline without this
// worker quietly eating gigabytes of the user's storage.

const VERSION = 'flyover-v1';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css',
];

// Cache-first, but never grow without bound.
const RUNTIME_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'esm.sh',
  'unpkg.com',
];
// Style, glyphs and sprites are small and fixed; the tiles under them are not.
const isMapMeta = url =>
  url.hostname === 'tiles.openfreemap.org' && !/\.(pbf|png)$/.test(url.pathname);

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll fails the whole install if any one request fails, and a CDN
    // hiccup should not leave the app uninstallable.
    await Promise.all(SHELL_URLS.map(u =>
      cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, RUNTIME]);
    await Promise.all((await caches.keys()).map(k => keep.has(k) ? null : caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Navigations: serve the app shell so a cold offline launch still boots.
  if (request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(request);
        // Keep the offline copy current. Without this the fallback stays
        // frozen at whatever was precached on the very first visit, so an
        // offline launch could serve a build from months ago.
        if (res.ok) (await caches.open(SHELL)).put('./index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  const runtimeWorthy = RUNTIME_HOSTS.includes(url.hostname) || isMapMeta(url);
  if (url.origin !== self.location.origin && !runtimeWorthy) return;   // tiles etc: untouched

  e.respondWith((async () => {
    const hit = await caches.match(request);
    if (hit) return hit;
    try {
      const res = await fetch(request);
      if (res.ok || res.type === 'opaque') {
        const cache = await caches.open(url.origin === self.location.origin ? SHELL : RUNTIME);
        cache.put(request, res.clone());
      }
      return res;
    } catch (err) {
      return (await caches.match(request)) || Response.error();
    }
  })());
});
