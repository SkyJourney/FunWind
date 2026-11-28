import { createHash, randomUUID } from "node:crypto";
import {
  expect,
  test as base,
  type APIResponse,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { loginAs, USERS } from "./support/session";

const RSS = "application/rss+xml";
const ATOM = "application/atom+xml";
const ATOM_NS = "http://www.w3.org/2005/Atom";
const LATEST = "/feeds/latest";
const forumFeed = (fid: number) => `/feeds/forum/${fid}`;
const HTML_HEADERS = { "user-agent": "Mozilla/5.0 FunWindE2E Chrome/144.0" };
const DISCOVERY_SELECTOR = `link[rel="alternate"][type="${RSS}"], link[rel="alternate"][type="${ATOM}"]`;

type FeedForum = {
  fid: number;
  tid: number;
  pid: number;
  marker: string;
  title: string;
  summary: string;
};

const test = base.extend<{ feedForum: FeedForum; admin: BrowserContext }>({
  feedForum: async ({}, provide) => {
    const marker = randomUUID();
    const title = `新主题 & 动画 ${marker}`;
    const summary = `公开摘要 & 动画 <b>纯文本</b> ${marker}`;
    // 每条用例只修改自建版块与首帖，失败时也按生成的主键定向删除。
    const seed = await withE2eDb(async (q) => {
      await q.exec("START TRANSACTION");
      const { insertId: fid } = await q.exec(
        "INSERT INTO forums (parent_id, name, read_policy) VALUES (0, ?, 'public')",
        [`订阅夹具 ${randomUUID()}`],
      );
      await q.exec("UPDATE forums SET path = ? WHERE id = ?", [`/${fid}/`, fid]);
      const { insertId: tid } = await q.exec(
        "INSERT INTO threads (forum_id, author_id, title, created_at, last_posted_at) VALUES (?, ?, ?, NOW(), NOW())",
        [fid, USERS.alice, title],
      );
      const { insertId: pid } = await q.exec(
        "INSERT INTO posts (thread_id, floor, author_id, body_md, created_at) VALUES (?, 1, ?, ?, NOW())",
        [tid, USERS.alice, `公开**摘要** & 动画 \`<b>纯文本</b>\` ${marker}\n\n后续正文 ${marker}`],
      );
      await q.exec("UPDATE threads SET first_post_id = ? WHERE id = ?", [pid, tid]);
      await q.exec("COMMIT");
      return { fid, tid, pid, marker, title, summary };
    });
    try {
      await provide(seed);
    } finally {
      await withE2eDb(async (q) => {
        await q.exec("DELETE FROM posts WHERE id = ?", [seed.pid]);
        await q.exec("DELETE FROM threads WHERE id = ?", [seed.tid]);
        await q.exec("DELETE FROM forums WHERE id = ?", [seed.fid]);
      });
    }
  },
  admin: async ({ browser, baseURL }, provide) => {
    const context = await browser.newContext({ baseURL });
    let token: string | undefined;
    try {
      token = await loginAs(context, USERS.admin);
      await provide(context);
    } finally {
      await context.close();
      if (token) {
        await withE2eDb((q) =>
          q.exec("DELETE FROM sessions WHERE id = ?", [
            createHash("sha256").update(token).digest("hex"),
          ]),
        );
      }
    }
  },
});

/** 先截出 HTTP 响应里的 head，再解析标签，防止水合或浏览器节点移动掩盖 SSR 回归。 */
async function readDiscovery(page: Page, response: APIResponse) {
  const html = await response.text();
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1];
  expect(head, "原始响应应有完整的 head 标签").toBeDefined();
  return page.evaluate(
    ({ head, selector }) => {
      const doc = new DOMParser().parseFromString(`<head>${head}</head>`, "text/html");
      return [...doc.head.querySelectorAll(selector)].map((link) => ({
        type: link.getAttribute("type"),
        href: link.getAttribute("href") ?? "",
      }));
    },
    { head, selector: DISCOVERY_SELECTOR },
  );
}

/** 使用真实 XML 解析器检查结构与实体解码。 */
async function readXml(page: Page, xml: string, atom: boolean) {
  return page.evaluate(
    ({ xml, atom }) => {
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const root = doc.documentElement;
      const namespace = root.namespaceURI;
      const element = (entry: Element, name: string) =>
        entry.getElementsByTagNameNS(namespace, name).item(0);
      return {
        error: doc.querySelector("parsererror")?.textContent ?? null,
        root: root.localName,
        namespace,
        version: root.getAttribute("version"),
        entries: [...doc.getElementsByTagNameNS(namespace, atom ? "entry" : "item")].map(
          (entry) => {
            const link = element(entry, "link");
            const summary = element(entry, atom ? "summary" : "description");
            // RSS 阅读器会按 HTML 解释描述，Atom 的摘要直接使用 XML 文本。
            const html = atom
              ? null
              : new DOMParser().parseFromString(summary?.textContent ?? "", "text/html");
            return {
              id: element(entry, atom ? "id" : "guid")?.textContent,
              title: element(entry, "title")?.textContent,
              link: atom ? link?.getAttribute("href") : link?.textContent,
              summary: html ? html.body.textContent : summary?.textContent,
              summaryHasElements: Boolean(
                html ? html.querySelector("head > *, body > *") : summary?.childElementCount,
              ),
            };
          },
        ),
      };
    },
    { xml, atom },
  );
}

function etagOf(response: APIResponse): string {
  const etag = response.headers().etag ?? "";
  expect(etag).not.toBe("");
  return etag;
}

function expectFeedType(response: APIResponse, type: string) {
  expect(response.headers()["content-type"].toLowerCase()).toMatch(
    new RegExp(`^${type.replace("+", "\\+")};\\s*charset=utf-8$`),
  );
}

async function expectUncachedError(response: APIResponse, status: number) {
  expect(response.status()).toBe(status);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers().etag).toBeUndefined();
  return response.text();
}

test("首页和公开版块原始 head 能发现两种订阅，受限版块不对管理员暴露订阅入口", async ({
  page,
  request,
  admin,
}) => {
  for (const headers of [HTML_HEADERS, { "user-agent": "FunWindFeedReader/1.0" }]) {
    for (const [pagePath, feedPath] of [
      ["/", LATEST],
      [`/f/${FIX.anime.id}`, forumFeed(FIX.anime.id)],
    ]) {
      const response = await request.get(pagePath, { headers });
      expect(response.status()).toBe(200);
      const links = await readDiscovery(page, response);
      expect(links.map(({ type }) => type).sort()).toEqual([ATOM, RSS]);
      const origins = new Set<string>();
      for (const { href, type } of links) {
        const url = new URL(href);
        expect(["http:", "https:"]).toContain(url.protocol);
        origins.add(url.origin);
        const target = url.pathname + url.search;
        expect(target).toBe(type === ATOM ? `${feedPath}?format=atom` : feedPath);
        // 只请求隔离测试服务，站点配置中的规范地址可能和测试服务不同。
        const feed = await request.get(target, { maxRedirects: 0 });
        expect(feed.status()).toBe(200);
        expectFeedType(feed, type!);
      }
      expect(origins.size).toBe(1);
    }
  }

  const restrictedPath = `/f/${FIX.staff.id}`;
  const anonymous = await request.get(restrictedPath, { headers: HTML_HEADERS });
  expect(anonymous.status()).toBe(404);
  expect(await readDiscovery(page, anonymous)).toEqual([]);
  const privileged = await admin.request.get(restrictedPath, { headers: HTML_HEADERS });
  expect(privileged.status()).toBe(200);
  const restrictedHtml = await privileged.text();
  expect(restrictedHtml).toContain(FIX.staff.name);
  expect(await readDiscovery(page, privileged)).toEqual([]);
  expect(restrictedHtml).not.toMatch(/<link\b[^>]*type="application\/(?:rss|atom)\+xml"/i);
  expect(restrictedHtml).not.toContain('aria-label="版块订阅"');
});

test("桌面和窄屏可以直接使用页内订阅链接", async ({ page }) => {
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, label, feedPath] of [
      ["/", "全站订阅", LATEST],
      [`/f/${FIX.anime.id}`, "版块订阅", forumFeed(FIX.anime.id)],
    ]) {
      await page.goto(path);
      const entry = page.getByRole("group", { name: label, exact: true });
      const rss = entry.getByRole("link", { name: "RSS 订阅", exact: true });
      const atom = entry.getByRole("link", { name: "Atom 订阅", exact: true });
      await expect(rss).toBeVisible();
      await expect(atom).toBeVisible();
      for (const [link, suffix] of [
        [rss, ""],
        [atom, "?format=atom"],
      ] as const) {
        const href = new URL((await link.getAttribute("href"))!);
        expect(href.pathname + href.search).toBe(`${feedPath}${suffix}`);
        await expect(link).not.toHaveCSS("position", /fixed|absolute|sticky/);
        const visibleInFlow = await link.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= window.innerWidth &&
            element.contains(
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
            )
          );
        });
        expect(visibleInFlow).toBe(true);
      }
    }
  }
});

test("RSS 与 Atom 均是游客表示，登录和强制换密 Cookie 不改变结果", async ({
  page,
  request,
  admin,
  baseURL,
  feedForum,
}) => {
  const forumPath = forumFeed(feedForum.fid);
  const sessionFeed = await admin.request.get(forumPath, { maxRedirects: 0 });
  expect(sessionFeed.status()).toBe(200);
  await admin.addCookies([{ name: "fw_must_change", value: "1", url: baseURL! }]);
  const ids = [];
  for (const [atom, type] of [
    [false, RSS],
    [true, ATOM],
  ] as const) {
    for (const path of [forumPath, LATEST]) {
      const target = `${path}${atom ? "?format=atom" : ""}`;
      const get = await request.get(target);
      expect(get.status()).toBe(200);
      expectFeedType(get, type);
      const xml = await get.text();
      const parsed = await readXml(page, xml, atom);
      expect(parsed).toMatchObject({
        error: null,
        root: atom ? "feed" : "rss",
        namespace: atom ? ATOM_NS : null,
        version: atom ? null : "2.0",
      });
      const entry = parsed.entries.find(({ title }) => title === feedForum.title);
      expect(entry).toMatchObject({
        id: expect.any(String),
        summary: feedForum.summary,
        summaryHasElements: false,
      });
      expect(entry?.id).not.toBe("");
      expect(new URL(entry!.link!).pathname).toBe(`/t/${feedForum.tid}`);
      ids.push(entry?.id);
      expect(xml).not.toContain(`后续正文 ${feedForum.marker}`);
      expect(xml).not.toContain(FIX.staffSecretTitle);
      if (path === forumPath && !atom) expect(await sessionFeed.text()).toBe(xml);

      const etag = etagOf(get);
      expect(get.headers()["cache-control"]).toBe("public, no-cache");
      const pending = await admin.request.get(target, { maxRedirects: 0 });
      expect(pending.status()).toBe(200);
      expect(etagOf(pending)).toBe(etag);
      expect(await pending.text()).toBe(xml);
      const head = await admin.request.head(target, { maxRedirects: 0 });
      expect(head.status()).toBe(200);
      expect(head.headers()["cache-control"]).toBe("public, no-cache");
      expectFeedType(head, type);
      expect(etagOf(head)).toBe(etag);
      expect(await head.body()).toHaveLength(0);
      for (const method of ["GET", "HEAD"]) {
        const cached = await admin.request.fetch(target, {
          method,
          headers: { "if-none-match": etag },
          maxRedirects: 0,
        });
        expect(cached.status()).toBe(304);
        expect(cached.headers()["cache-control"]).toBe("public, no-cache");
        expect(etagOf(cached)).toBe(etag);
        expect(await cached.body()).toHaveLength(0);
      }
    }
  }
  expect(new Set(ids).size).toBe(1);

  for (const other of ["/boards", "/feeds/other", `${forumPath}/extra`]) {
    const response = await admin.request.get(other, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers().location).toMatch(/\/settings\/password\?force=1$/);
  }
  const malformed = await admin.request.get("/feeds/forum/%C0%AE", { maxRedirects: 0 });
  expect(malformed.status()).toBe(404);
});

test("非法格式为 400，受限、分区、非法和不存在的版块使用相同的 404", async ({ request, admin }) => {
  const invalidFormat = await request.get(`${LATEST}?format=json`);
  await expectUncachedError(invalidFormat, 400);
  const invalidHead = await request.head(`${LATEST}?format=json`);
  expect(await expectUncachedError(invalidHead, 400)).toBe("");

  const missing = await request.get(forumFeed(4294967295));
  const notFound = await expectUncachedError(missing, 404);
  // 950 是测试库夹具里的分区而非可发帖版块。
  for (const path of [forumFeed(FIX.staff.id), forumFeed(950), "/feeds/forum/invalid"]) {
    for (const client of [request, admin.request]) {
      const denied = await client.get(path, { maxRedirects: 0 });
      expect(await expectUncachedError(denied, 404)).toBe(notFound);
      const atomHead = await client.head(`${path}?format=atom`, { maxRedirects: 0 });
      expect(await expectUncachedError(atomHead, 404)).toBe("");
    }
  }
});

test("首帖撤回与版块权限收紧后，旧 ETag 不能重用已发布表示", async ({
  page,
  request,
  feedForum,
}) => {
  const forumPath = `${forumFeed(feedForum.fid)}?format=atom`;
  const oldForum = await request.get(forumPath);
  expect(oldForum.status()).toBe(200);
  expect(await oldForum.text()).toContain(feedForum.marker);
  const initialEtag = etagOf(oldForum);
  const setPostState = (state: "visible" | "hidden") =>
    withE2eDb((q) => q.exec("UPDATE posts SET state = ? WHERE id = ?", [state, feedForum.pid]));

  // 只撤回首帖，主题仍为 visible，应得到新的空 Atom 源。
  await setPostState("hidden");
  const empty = await request.get(forumPath, { headers: { "if-none-match": initialEtag } });
  expect(empty.status()).toBe(200);
  expect(etagOf(empty)).not.toBe(initialEtag);
  const emptyXml = await empty.text();
  expect(emptyXml).not.toContain(feedForum.marker);
  expect(await readXml(page, emptyXml, true)).toMatchObject({ error: null, entries: [] });

  await setPostState("visible");
  const restoredForum = await request.get(forumPath);
  const latest = await request.get(LATEST);
  for (const response of [restoredForum, latest]) {
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(feedForum.marker);
  }
  await withE2eDb((q) =>
    q.exec("UPDATE forums SET read_policy = 'members' WHERE id = ?", [feedForum.fid]),
  );
  const revoked = await request.get(forumPath, {
    headers: { "if-none-match": etagOf(restoredForum) },
  });
  expect(await expectUncachedError(revoked, 404)).not.toContain(feedForum.marker);
  const latestEtag = etagOf(latest);
  const filtered = await request.get(LATEST, { headers: { "if-none-match": latestEtag } });
  expect(filtered.status()).toBe(200);
  expect(etagOf(filtered)).not.toBe(latestEtag);
  expect(await filtered.text()).not.toContain(feedForum.marker);
});

test.describe("PWA 订阅请求", () => {
  test.use({ serviceWorkers: "allow" });

  test("接管页面保持源站重验证，离线时不返回旧订阅或离线壳", async ({
    page,
    context,
    feedForum,
  }) => {
    const path = forumFeed(feedForum.fid);
    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
      .toBe(true);

    const before = await page.evaluate(async (path) => {
      const response = await fetch(path);
      const body = await response.text();
      const wasCached = Boolean(await caches.match(path));
      // 放入旧副本，验证接下来的在线请求和离线导航均不从 CacheStorage 复用它。
      const cache = await caches.open("funwind-pwa-assets-v1");
      await cache.put(path, new Response(body, { headers: response.headers }));
      return { status: response.status, body, wasCached };
    }, path);
    expect(before.status).toBe(200);
    expect(before.body).toContain(feedForum.marker);
    expect(before.wasCached).toBe(false);

    await withE2eDb((q) =>
      q.exec("UPDATE posts SET state = 'hidden' WHERE id = ?", [feedForum.pid]),
    );
    const after = await page.evaluate(async (path) => {
      const response = await fetch(path);
      return { status: response.status, body: await response.text() };
    }, path);
    expect(after.status).toBe(200);
    expect(after.body).not.toContain(feedForum.marker);

    await context.setOffline(true);
    try {
      const offline = await page.evaluate(async (path) => {
        try {
          await fetch(path);
          return "responded";
        } catch (error) {
          return (error as Error).name;
        }
      }, path);
      expect(offline).toBe("TypeError");
      await expect(page.goto(path)).rejects.toThrow(/net::ERR_/);
    } finally {
      await context.setOffline(false);
    }
  });
});
