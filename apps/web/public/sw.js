/*
 * FunWind 最小 PWA Service Worker（M11 Step 7）。
 * 隐私边界：绝不缓存任何页面 HTML/RSC、API、/files、/brand（可能是个性化/可变内容）；
 * 只缓存通用 offline.html 离线壳与带版本哈希/公开可读的静态资源。动态页面断网时回退通用离线壳。
 */
const CACHE_PREFIX = "funwind-pwa-";
// 离线壳缓存跟部署版本（M16.1 Step 3）：注册 URL 带 ?v=<BUILD_ID>，每次部署脚本 URL 都不同，
// 浏览器必然重装一次 → 离线壳跟着刷新，不再依赖手改 `-v1` 常量（改策略忘 bump 是真实风险）。
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
// 静态资源缓存**不跟版本**：/_next/static/ 是内容哈希 URL，换了内容就是换了 URL，
// 旧条目天然不会被命中。跟着部署清缓存只会让每次发版后首访重新下载，纯亏带宽。
// 这里的 v1 是「缓存策略版本」，只有白名单/策略本身变化时才需要手改。
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

// ============================================================
// Web Push（M18 Step 5）：push 展示通知 / notificationclick 聚焦跳转 / pushsubscriptionchange 重订阅。
// 隐私边界不变：推送 payload 只含标题/正文/站内跳转 URL，不缓存任何个性化内容。
// ============================================================

/** VAPID 公钥（base64url）→ PushManager.subscribe 所需的 Uint8Array（与 lib/push/client.ts 同算法） */
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || "青翼字幕组";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/pwa/icon-192.png",
      badge: "/pwa/icon-192.png",
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // 只允许站内跳转（同源校验，防 payload 被篡改导致开放重定向）
  const raw = (event.notification.data && event.notification.data.url) || "/";
  let target;
  try {
    target = new URL(raw, self.location.origin);
    if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);
  } catch {
    target = new URL("/", self.location.origin);
  }
  const href = target.href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // 已有窗口：聚焦并导航到目标；无窗口：开新窗口
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) client.navigate(href);
          return;
        }
      }
      return self.clients.openWindow(href);
    }),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // 订阅失效/更新时重新订阅并上报新凭据（需用户已登录，SW fetch 同源自动带会话 cookie）
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch("/api/push/vapid-public-key");
        const { publicKey } = await res.json();
        if (!publicKey) return;
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        const json = sub.toJSON();
        await fetch("/api/push/subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: sub.endpoint,
            p256dh: (json.keys && json.keys.p256dh) || "",
            auth: (json.keys && json.keys.auth) || "",
          }),
        });
      } catch {
        // 重订阅失败不反噬；用户下次开启推送时再试
      }
    })(),
  );
});
