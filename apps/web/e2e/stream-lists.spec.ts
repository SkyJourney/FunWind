import { expect, test, type Page } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

/**
 * 用户主页「主题 / 回复」与关注动态的流式加载（M10.7 Step 3b）。
 * 数据：alice(90001) 是水区 60 个主题的作者（每页 10 条共 6 页以上）；关注动态用例临时让 xiaoyi 关注水区，用完清掉。
 */

const threadRows = (page: Page) => page.locator("main a.font-medium[href^='/t/']");
const replyRows = (page: Page) => page.locator("main a[href^='/p/']");
const followCards = (page: Page) => page.locator("main article");

async function scrollUntilMore(page: Page, count: () => Promise<number>, before: number) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        return count();
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(before);
}

test.describe("用户主页 · 主题 tab", () => {
  test("触底追加：首屏 10 行，追加后无重复；追加项淡入、首屏错落", async ({ page }) => {
    await page.goto(`/u/${USERS.alice}`);
    await expect(threadRows(page)).toHaveCount(10);
    const delays = await page
      .locator("main .fw-enter")
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).animationDelay));
    expect(delays.slice(0, 3)).toEqual(["0s", "0.05s", "0.1s"]);

    await scrollUntilMore(page, () => threadRows(page).count(), 10);
    const hrefs = await threadRows(page).evaluateAll((els) =>
      els.map((e) => e.getAttribute("href")),
    );
    expect(new Set(hrefs).size).toBe(hrefs.length);
    await expect(page.locator("main .fw-fade-in").first()).toBeVisible();
  });

  test("直达 ?page=3 从第 3 页起；有 JS 时不渲染翻页条", async ({ page }) => {
    await page.goto(`/u/${USERS.alice}?page=3`);
    await expect(threadRows(page)).toHaveCount(10);
    await expect(page.getByText(/第 3 \/ \d+ 页/)).toHaveCount(0);
    await scrollUntilMore(page, () => threadRows(page).count(), 10);
  });
});

test.describe("用户主页 · 回复 tab", () => {
  test("触底追加：回复行增加且无重复", async ({ page }) => {
    await page.goto(`/u/${USERS.alice}?tab=replies`);
    await expect(replyRows(page)).toHaveCount(10);
    await scrollUntilMore(page, () => replyRows(page).count(), 10);
    const hrefs = await replyRows(page).evaluateAll((els) =>
      els.map((e) => e.getAttribute("href")),
    );
    expect(new Set(hrefs).size).toBe(hrefs.length);
    // 取数端点带上 tab，不会串到主题列表
    const res = await page.request.get(`/api/stream/user/${USERS.alice}?tab=replies&page=2`);
    const body = (await res.json()) as { items: { postId: number; id: number }[] };
    expect(body.items.every((i) => i.id === i.postId)).toBe(true);
  });
});

test.describe("用户主页 · 无 JS 兜底", () => {
  test.use({ javaScriptEnabled: false });

  test("翻页条与「下一页」真链接可用", async ({ page }) => {
    await page.goto(`/u/${USERS.alice}`);
    await expect(page.getByText(/第 1 \/ \d+ 页/)).toBeVisible();
    await expect(page.locator("a[rel=next]")).toHaveAttribute("href", `/u/${USERS.alice}?page=2`);
    await page.goto(`/u/${USERS.alice}?tab=replies&page=2`);
    await expect(page.getByText(/第 2 \/ \d+ 页/)).toBeVisible();
  });
});

test.describe("用户内容取数端点", () => {
  test("越界页为空、占位账号与不存在的用户 404", async ({ request }) => {
    const over = await request.get(`/api/stream/user/${USERS.alice}?page=500`);
    expect(await over.json()).toMatchObject({ items: [], hasMore: false });
    expect(over.headers()["cache-control"]).toBe("private, no-store");
    // 已注销用户占位账号不开个人页，端点同口径 404
    expect((await request.get(`/api/stream/user/${FIX.placeholderUserId}?page=1`)).status()).toBe(
      404,
    );
    expect((await request.get(`/api/stream/user/9999999?page=1`)).status()).toBe(404);
    expect((await request.get(`/api/stream/user/abc?page=1`)).status()).toBe(404);
  });
});

test.describe("关注动态", () => {
  test.beforeEach(async () => {
    // xiaoyi 关注水区（60 个主题）；其他用例不使用该账号的关注
    await withE2eDb((q) =>
      q.exec(
        "INSERT IGNORE INTO follows (user_id, target_type, target_id, created_at) VALUES (?, 'forum', ?, NOW())",
        [USERS.xiaoyi, FIX.water.id],
      ),
    );
  });
  test.afterEach(async () => {
    await withE2eDb((q) => q.exec("DELETE FROM follows WHERE user_id = ?", [USERS.xiaoyi]));
  });

  test("触底追加卡片、无重复；类型筛选参数透传取数端点", async ({ page, context }) => {
    await loginAs(context, USERS.xiaoyi);
    await page.goto("/follows");
    // 关注动态每页 25 条（THREADS_PER_PAGE）；错落进场只给前 10 张
    await expect(followCards(page)).toHaveCount(25);
    await expect(page.locator("main .fw-enter")).toHaveCount(10);
    await scrollUntilMore(page, () => followCards(page).count(), 25);
    const hrefs = await page
      .locator("main article h3 a")
      .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(new Set(hrefs).size).toBe(hrefs.length);

    await page.goto("/follows?type=forum");
    const requested = page.waitForRequest((r) => r.url().includes("/api/stream/follows"));
    await page.getByRole("link", { name: "加载更多" }).click();
    const url = (await requested).url();
    expect(url).toContain("type=forum");
    expect(url).toContain("page=2");
  });

  test("无 JS：翻页条保留类型筛选（修复原先翻页丢 ?type=）", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    try {
      await loginAs(context, USERS.xiaoyi);
      const page = await context.newPage();
      await page.goto("/follows?type=forum");
      await expect(page.locator("a[rel=next]")).toHaveAttribute(
        "href",
        "/follows?type=forum&page=2",
      );
      await expect(page.getByRole("navigation", { name: "分页" })).toBeVisible();
      const hrefs = await page
        .getByRole("navigation", { name: "分页" })
        .locator("a")
        .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
      expect(hrefs.length).toBeGreaterThan(0);
      expect(hrefs.every((h) => h?.includes("type=forum"))).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("取数端点：游客 401；登录后越界页为空", async ({ request, context, page }) => {
    expect((await request.get("/api/stream/follows?page=1")).status()).toBe(401);
    await loginAs(context, USERS.xiaoyi);
    const res = await page.request.get("/api/stream/follows?page=999");
    expect(await res.json()).toMatchObject({ items: [], hasMore: false });
  });
});
