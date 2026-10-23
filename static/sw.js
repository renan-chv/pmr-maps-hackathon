// Roulib service worker: instant reloads and a usable app without network (metro, tunnels).
// - App shell: network first (a new deploy shows at once), last version offline. Libraries: cache first.
// - Map tiles and fonts: cache first, capped.
// - API GETs: network first (4 s), fall back to the last answer. Payloads carry their own fetched_at,
//   so the UI keeps showing how old the data is. Live journeys and POSTs are never served from cache.
// - Report photos (/api/reports/{id}/thumb): they never change, cache first, capped.
const V = "roulib-v3";
// native.js does nothing in a browser, but index.html loads it: cached so an offline reload has no failed script.
const SHELL = ["/", "/static/style.css", "/static/app.js", "/static/profiles.js", "/static/native.js", "/static/manifest.webmanifest", "/static/icon.svg"];
const TILE_MAX = 400, API_MAX = 200, IMG_MAX = 80;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.startsWith(V)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trim(name, max) {
  const c = await caches.open(name), keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
async function cacheFirst(req, name, max) {
  const c = await caches.open(name), hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === "opaque") { c.put(req, r.clone()); trim(name, max); }
  return r;
}
async function networkFirst(req, name) {
  const c = await caches.open(name);
  // The request keeps running after the 4 s timeout: slow answers (restaurants ~5 s) still arrive and get cached.
  // Every map area asks its own URL: the cache keeps the most recent answers only.
  const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()).then(() => trim(name, API_MAX)); return r; });
  try {
    return await Promise.race([net, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 4000))]);
  } catch {
    const hit = await c.match(req);
    return hit || net;  // nothing cached yet: wait for the network instead of failing
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname === "/api/journey" && url.searchParams.get("replay") !== "demo") return; // always live
    if (/^\/api\/reports\/\d+\/thumb$/.test(url.pathname)) return e.respondWith(cacheFirst(req, `${V}-img`, IMG_MAX));
    if (url.pathname.startsWith("/api/")) return e.respondWith(networkFirst(req, `${V}-api`));
    // Network first for the app itself: after a deploy, the next load shows the new version (offline: last one).
    if (url.pathname === "/" || url.pathname.startsWith("/static/")) return e.respondWith(networkFirst(req, V));
    return;
  }
  if (/tiles\.openfreemap\.org$/.test(url.hostname)) return e.respondWith(cacheFirst(req, `${V}-tiles`, TILE_MAX));
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || url.hostname === "unpkg.com") return e.respondWith(cacheFirst(req, `${V}-lib`, 60));
});
