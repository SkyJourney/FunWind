import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";

/**
 * PWA（M11 Step 7）：manifest installability metadata + icons、生产 Service Worker 注册、
 * 通用 offline shell 预缓存、离线导航回退；断言动态页面不进入 CacheStorage（隐私边界）。
 * 只在 production project 跑；开发模式不注册 SW，避免污染 HMR。
 */
test.use({ serviceWorkers: "allow" });
failOnPageErrors();

const POOL_LOGO = `logo-pwae2e${Date.now().toString(36)}.png`;
const poolLogoPath = path.join(process.env.STORAGE_DIR ?? "", "site", POOL_LOGO);
let previousSiteLogo: string | null = null;

test.beforeAll(async () => {
  await mkdir(path.dirname(poolLogoPath), { recursive: true });
  await writeFile(
    poolLogoPath,
    await sharp({ create: { width: 224, height: 224, channels: 4, background: "#e91e63" } })
      .png()
      .toBuffer(),
  );
  await withE2eDb(async (q) => {
    const [row] = await q.query<{ value: unknown }>(
      "SELECT `value` FROM site_settings WHERE `key` = 'site.logo'",
    );
    previousSiteLogo = row ? JSON.stringify(row.value) : null;
    await q.exec(
      "INSERT INTO site_settings (`key`, `value`, `updated_at`) " +
        "VALUES ('site.logo', JSON_OBJECT('items', JSON_ARRAY(JSON_OBJECT('file', ?, 'name', 'PWA E2E')), 'active', ?), NOW()) " +
        "ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updated_at` = NOW()",
      [POOL_LOGO, POOL_LOGO],
    );
  });
});

test.afterAll(async () => {
  await withE2eDb(async (q) => {
    if (previousSiteLogo === null) {
      await q.exec("DELETE FROM site_settings WHERE `key` = 'site.logo'");
    } else {
      await q.exec("UPDATE site_settings SET `value` = CAST(? AS JSON) WHERE `key` = 'site.logo'", [
        previousSiteLogo,
      ]);
    }
  });
  await rm(poolLogoPath, { force: true });
});

test("manifest：具备可安装字段和 192/512/maskable 图标，图标跟随当前 LOGO 池项", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    name: "青翼字幕组",
    short_name: "青翼字幕组",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ src: "/brand/pwa-icon/192", sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ src: "/brand/pwa-icon/512", sizes: "512x512", purpose: "any" }),
      expect.objectContaining({
        src: "/brand/pwa-icon/maskable-512",
        sizes: "512x512",
        purpose: "maskable",
      }),
    ]),
  );
  for (const icon of manifest.icons) {
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()["content-type"]).toContain("image/png");
  }
  const dynamicIcon = await request.get("/brand/pwa-icon/192");
  const staticFallback = await request.get("/pwa/icon-192.png");
  expect(
    Buffer.compare(Buffer.from(await dynamicIcon.body()), Buffer.from(await staticFallback.body())),
  ).not.toBe(0);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  // Lighthouse themed-omnibox：地址栏状态颜色必须有明确 meta，且与 manifest 的站点默认主题同口径。
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0e7490");
});

test("生产 SW：通用离线壳预缓存；断网动态页面返回离线壳，任何个性化页面均不缓存", async ({
  page,
  context,
}) => {
  await page.goto("/");
  // SW 注册在 layout useEffect；首次访问后等待激活并接管当前 tab
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.reload();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
  }
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);

  const onlineState = await page.evaluate(async () => {
    const keys = await caches.keys();
    // 离线壳缓存名跟部署版本（M16.1 Step 3：?v=<BUILD_ID>），按前缀发现而不是写死名字
    const shellName = keys.find((k) => k.startsWith("funwind-pwa-shell-")) ?? "";
    const shell = await caches.open(shellName);
    const offline = await shell.match("/offline.html");
    return {
      controller: Boolean(navigator.serviceWorker.controller),
      hasShell: shellName !== "",
      shellName,
      offlineStatus: offline?.status ?? null,
      cachedUrls: (await Promise.all(keys.map(async (key) => (await caches.open(key)).keys())))
        .flat()
        .map((request) => new URL(request.url).pathname),
    };
  });
  expect(onlineState).toMatchObject({ controller: true, hasShell: true, offlineStatus: 200 });
  // 版本号必须真的带上（不是回落 dev）：注册 URL 与壳缓存名同源
  expect(onlineState.shellName).toMatch(/^funwind-pwa-shell-.+/);
  expect(onlineState.shellName).not.toBe("funwind-pwa-shell-dev");
  const scriptUrl = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.active?.scriptURL ?? "";
  });
  expect(scriptUrl).toContain("/sw.js?v=");
  expect(decodeURIComponent(scriptUrl.split("?v=")[1] ?? "")).toBe(
    onlineState.shellName.replace("funwind-pwa-shell-", ""),
  );
  expect(onlineState.cachedUrls).toContain("/offline.html");
  expect(
    onlineState.cachedUrls.every(
      (path) =>
        path === "/offline.html" ||
        path.startsWith("/_next/static/") ||
        path.startsWith("/pwa/") ||
        path.startsWith("/emoji/"),
    ),
  ).toBe(true);

  // 即使用户刚访问过私人/动态主题页，SW 也不得把其 HTML/RSC 持久化进 CacheStorage
  await page.goto("/t/900004");
  await page.waitForLoadState("domcontentloaded");
  const dynamicCached = await page.evaluate(async () =>
    (await Promise.all((await caches.keys()).map(async (key) => (await caches.open(key)).keys())))
      .flat()
      .map((request) => new URL(request.url).pathname)
      .filter(
        (path) =>
          path.startsWith("/t/") ||
          path.startsWith("/api/") ||
          path.startsWith("/files/") ||
          path.startsWith("/brand/"),
      ),
  );
  expect(dynamicCached).toEqual([]);

  // 此时页面已由 SW 接管，静态资源已走 cache-first：资源缓存必须仍是**策略版本**常量，
  // 不跟部署版本（内容哈希 URL 天然免疫，跟着部署清缓存只会白白重下）
  const cacheNames = await page.evaluate(() => caches.keys());
  expect(cacheNames).toContain("funwind-pwa-assets-v1");
  expect(cacheNames.filter((k) => k.startsWith("funwind-pwa-shell-"))).toHaveLength(1);

  await context.setOffline(true);
  await page.goto("/t/900004");
  await expect(page.getByRole("heading", { name: "暂时离线" })).toBeVisible();
  await expect(page.getByText(/页面内容不会在设备上缓存/)).toBeVisible();
  await expect(page.getByText("[门控演示] 付费与回复可见")).toHaveCount(0);
  await context.setOffline(false);
});

test("联网状态感知：断网给常驻提示，恢复后撤下并确认（M16.1 Step 3）", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // 在线进站不该平白提示「网络已恢复」
  await expect(page.getByText("网络已恢复")).toHaveCount(0);

  // 不导航、只断网：页面仍是应用本体，ConnectionStatus 应当感知到
  await context.setOffline(true);
  await expect(page.getByText("网络已断开")).toBeVisible();
  await expect(page.getByText("暂时无法加载新内容，恢复后会自动提示。")).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText("网络已恢复")).toBeVisible();
  await expect(page.getByText("网络已断开")).toHaveCount(0);
});

test("SW 推送扩展：push/notificationclick/pushsubscriptionchange 三监听器就位，通知图标可达（M18 Step 5）", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // 真实推送送达需推送服务 + 站长真机（含 iOS PWA）；这里断言 SW 推送基建已部署、图标可缓存
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  const script = await sw.text();
  expect(script).toContain('addEventListener("push"');
  expect(script).toContain('addEventListener("notificationclick"');
  expect(script).toContain('addEventListener("pushsubscriptionchange"');
  expect(script).toContain("showNotification");
  const icon = await request.get("/pwa/icon-192.png");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toContain("image/png");
});

test("SW push 监听器行为：派发 push 事件真触发 showNotification（M18 Step 6.5，空监听器即红）", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // 在 SW 作用域内替身 showNotification 并派发 push 事件，断言监听器真的展示通知（非仅源码含字符串）。
  // 无 data 的 push 事件 → 默认标题；完整 payload 解析与 notificationclick 跳转由站长真机验证。
  const shown = await sw.evaluate(async () => {
    const scope = self as unknown as {
      registration: ServiceWorkerRegistration;
      dispatchEvent: (e: Event) => boolean;
    };
    const reg = scope.registration;
    let captured: { title: string } | null = null;
    const orig = reg.showNotification.bind(reg);
    reg.showNotification = ((title: string) => {
      captured = { title };
      return Promise.resolve();
    }) as typeof reg.showNotification;
    scope.dispatchEvent(new Event("push"));
    await new Promise((r) => setTimeout(r, 100));
    reg.showNotification = orig;
    return captured;
  });
  expect(shown).not.toBeNull();
  expect(shown!.title).toBe("青翼字幕组");
});
