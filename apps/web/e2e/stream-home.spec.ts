import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";

/**
 * 首页内容流的流式加载（M10.7，BUG3）。数据来自演示种子 + E2E 夹具（水区 60 帖 + 动画区若干），
 * 每页 10 条，保证首页不止一页。
 */

const cards = (page: import("@playwright/test").Page) => page.locator("main article");

/** 滚到页面底部直到卡片数超过 before（IntersectionObserver 触发取数） */
async function loadMoreByScrolling(page: import("@playwright/test").Page, before: number) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        return cards(page).count();
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(before);
}

test.describe("首页流式加载", () => {
  test("触底自动追加：卡片数增加、无重复主题、追加项带无延迟淡入类", async ({ page }) => {
    await page.goto("/");
    const first = await cards(page).count();
    expect(first).toBe(10);

    await loadMoreByScrolling(page, first);

    const hrefs = await page
      .locator("main article h3 a")
      .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    // 追加项只有淡入，没有错落延迟（站长 2026-10-28 裁定）
    const appended = page.locator("main article.fw-fade-in").first();
    await expect(appended).toBeVisible();
    expect(await appended.evaluate((el) => getComputedStyle(el).animationDelay)).toBe("0s");
  });

  test("减少动态效果下追加项不播动画（明确决策，保持）", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await loadMoreByScrolling(page, 10);
    const appended = page.locator("main article.fw-fade-in").first();
    expect(await appended.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });

  test("直达 ?page=2：从第 2 页起，提供「上一页」真链接并可继续追加", async ({ page }) => {
    await page.goto("/?page=2");
    await expect(page.getByRole("link", { name: "← 上一页" })).toHaveAttribute("href", "/");
    const first = await cards(page).count();
    expect(first).toBeGreaterThan(0);
    await loadMoreByScrolling(page, first);
  });

  test("点击「加载更多」就地追加，不整页跳转", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "加载更多" }).click();
    await expect.poll(() => cards(page).count()).toBeGreaterThan(10);
    await expect(page).toHaveURL(/\/$/);
  });

  test("排序与分区参数透传给取数端点", async ({ page }) => {
    await page.goto("/?sort=new");
    const requested = page.waitForRequest((r) => r.url().includes("/api/stream/home"));
    await page.getByRole("link", { name: "加载更多" }).click();
    expect((await requested).url()).toContain("sort=new");
    expect((await requested).url()).toContain("page=2");
  });
});

test.describe("首页流式加载 · 无 JS 兜底", () => {
  test.use({ javaScriptEnabled: false });

  test("底部是指向下一页的真链接，普通翻页可用", async ({ page }) => {
    await page.goto("/");
    const next = page.locator("a[rel=next]");
    await expect(next).toHaveAttribute("href", "/?page=2");
    await page.goto("/?page=2");
    await expect(page.getByRole("link", { name: "← 上一页" })).toBeVisible();
    expect(await cards(page).count()).toBeGreaterThan(0);
  });
});

test.describe("取数端点 · 权限", () => {
  test("游客读不到的版块：板块取数端点 404，首页流里也不出现该版块的主题", async ({ request }) => {
    const res = await request.get(`/api/stream/forum/${FIX.staff.id}?page=1`);
    expect(res.status()).toBe(404);
    expect(res.headers()["cache-control"]).toBe("private, no-store");

    for (let p = 1; p <= 8; p++) {
      const body = (await (await request.get(`/api/stream/home?page=${p}`)).json()) as {
        items: { forumId: number }[];
      };
      expect(body.items.some((i) => i.forumId === FIX.staff.id)).toBe(false);
    }
  });
});
