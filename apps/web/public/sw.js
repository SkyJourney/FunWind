/*
 * FunWind 最小 PWA Service Worker（M11 Step 7）。
 * 隐私边界：绝不缓存任何页面 HTML/RSC、API、/files、/brand（可能是个性化/可变内容）；
 * 只缓存通用 offline.html 离线壳与带版本哈希/公开可读的静态资源。动态页面断网时回退通用离线壳。
 */
const CACHE_PREFIX = "funwind-pwa-";
const SHELL_CACHE = `${CACHE_PREFIX}shell-v1`;
const ASSET_CACHE = `${CACHE_PREFIX}assets-v1`;
const OFFLINE_URL = "/offline.html";
const STATIC_PREFIXES = ["/_next/static/", "/pwa/", "/emoji/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE && name !== ASSET_CACHE,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(async () => {
        const shell = await caches.match(OFFLINE_URL, { cacheName: SHELL_CACHE });
        return (
          shell ??
          new Response("暂时离线，请联网后重试。", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
          })
        );
      }),
    );
    return;
  }

  if (!STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") await cache.put(request, response.clone());
      return response;
    })(),
  );
});
