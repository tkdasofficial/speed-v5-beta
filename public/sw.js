// Speed App Shell service worker.
// Hashed build assets: cache-first (immutable). Navigations: network-first with
// cached shell fallback. Server functions, API routes and websockets are never cached.
const VERSION = "speed-shell-v1";
const ASSETS = `${VERSION}-assets`;
const PAGES = `${VERSION}-pages`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(VERSION)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isAsset = (u) => u.pathname.startsWith("/assets/") || /\.(?:js|css|woff2?|svg|png|jpg|webp|ico)$/.test(u.pathname);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/_serverFn") || url.pathname.startsWith("/api/")) return;

  if (url.origin === self.location.origin && isAsset(url)) {
    e.respondWith((async () => {
      const c = await caches.open(ASSETS);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    })());
    return;
  }

  if (req.mode === "navigate") {
    e.respondWith((async () => {
      const c = await caches.open(PAGES);
      try {
        const res = await fetch(req);
        if (res.ok && res.type === "basic") c.put(req, res.clone());
        return res;
      } catch {
        return (await c.match(req)) || (await c.match("/dashboard")) || Response.error();
      }
    })());
    return;
  }

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(ASSETS).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })));
  }
});
