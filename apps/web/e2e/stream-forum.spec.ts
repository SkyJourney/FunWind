import { expect, test, type Page } from "@playwright/test";
import { FIX } from "./support/fixtures";

/**
 * 板块页主题的流式加载（M10.7，BUG12）。水区夹具：60 个普通主题、每页 25 条共 3 页，另有置顶块。
 */

/** 普通主题行（不含置顶块）：标题链接 */
const rows = (page: Page) =>
  page.locator("main section:not([aria-label]) a.font-medium[href^='/t/']");

/** 滚到底部直到主题行数达到 target（IntersectionObserver 触发取数） */
async function scrollUntil(page: Page, target: number) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        return rows(page).count();
      },
      { timeout: 10_000 },
    )
    .toBe(target);
}

test.describe("板块页流式加载", () => {
  test("触底自动追加到底：25 → 50 → 60，无重复，到底提示出现", async ({ page }) => {
    await page.goto(`/f/${FIX.water.id}`);
    await expect(rows(page)).toHaveCount(FIX.water.perPage);

    await scrollUntil(page, FIX.water.perPage * 2);
    await scrollUntil(page, FIX.water.total);

    const hrefs = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    await expect(page.getByText("没有更多了")).toBeVisible();
    // 追加完成后链接消失
    await expect(page.locator("a[rel=next]")).toHaveCount(0);
  });

  test("追加项无延迟淡入；首屏前 10 行错落进场（延迟递增）", async ({ page }) => {
    await page.goto(`/f/${FIX.water.id}`);
    const delays = await page
      .locator("main section:not([aria-label]) .fw-enter")
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).animationDelay));
    expect(delays.slice(0, 3)).toEqual(["0s", "0.05s", "0.1s"]);
    expect(delays).toHaveLength(10);

    await scrollUntil(page, FIX.water.perPage * 2);
    const appended = page.locator("main section:not([aria-label]) .fw-fade-in").first();
    await expect(appended).toBeVisible();
    expect(await appended.evaluate((el) => getComputedStyle(el).animationDelay)).toBe("0s");
  });

  test("减少动态效果下首屏与追加项都不播动画（明确决策，保持）", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/f/${FIX.water.id}`);
    const first = page.locator("main section:not([aria-label]) .fw-enter").first();
    expect(await first.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    await scrollUntil(page, FIX.water.perPage * 2);
    const appended = page.locator("main section:not([aria-label]) .fw-fade-in").first();
    expect(await appended.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });

  test("直达 ?page=2 从第 2 页起，追加只到第 3 页；有 JS 时数字分页不渲染", async ({ page }) => {
    await page.goto(`/f/${FIX.water.id}?page=2`);
    await expect(rows(page)).toHaveCount(FIX.water.perPage);
    await expect(page.getByText(/第 2\/3 页/)).toBeVisible();
    // 第 2 页 25 行 + 追加第 3 页 10 行；第 1 页不会被回头追加
    await scrollUntil(page, FIX.water.total - FIX.water.perPage);
    await expect(page.getByText("没有更多了")).toBeVisible();
    // 数字分页只在无 JS（noscript）时存在
    await expect(page.getByRole("navigation", { name: /分页/ })).toHaveCount(0);
  });

  test("点击「加载更多」就地追加，不整页跳转；置顶块只在首屏、不进追加页", async ({ page }) => {
    await page.goto(`/f/${FIX.water.id}`);
    await page.getByRole("link", { name: "加载更多" }).click();
    await expect(rows(page)).toHaveCount(FIX.water.perPage * 2);
    await expect(page).toHaveURL(new RegExp(`/f/${FIX.water.id}$`));
    await expect(page.getByRole("region", { name: "置顶主题" })).toHaveCount(1);
  });

  test("前缀筛选参数透传给取数端点", async ({ page }) => {
    // 动画区带前缀「连载中」；筛选后的列表即使不足一页，也要保证端点参数口径一致（用端点直接核对）
    const res = await page.request.get(
      `/api/stream/forum/${FIX.anime.id}?type=${FIX.anime.prefixId}&page=1`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { items: { prefixName: string | null }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.prefixName === FIX.anime.prefixName)).toBe(true);
  });
});

test.describe("板块页流式加载 · 无 JS 兜底", () => {
  test.use({ javaScriptEnabled: false });

  test("数字分页与「下一页」真链接都可用，普通翻页到第 2 页", async ({ page }) => {
    await page.goto(`/f/${FIX.water.id}`);
    await expect(page.locator("a[rel=next]")).toHaveAttribute("href", `/f/${FIX.water.id}?page=2`);
    await expect(page.getByText(/第 1\/3 页/)).toBeVisible();
    await page.goto(`/f/${FIX.water.id}?page=2`);
    await expect(page.getByText(/第 2\/3 页/)).toBeVisible();
  });
});

test.describe("板块取数端点", () => {
  test("分页边界：第 2 页 hasMore、末页 hasMore=false、越界页为空；受限板块 404", async ({
    request,
  }) => {
    const get = async (p: number) =>
      (await (await request.get(`/api/stream/forum/${FIX.water.id}?page=${p}`)).json()) as {
        items: unknown[];
        hasMore: boolean;
      };
    expect(await get(2)).toMatchObject({ hasMore: true });
    const last = await get(3);
    expect(last.hasMore).toBe(false);
    expect(last.items).toHaveLength(FIX.water.total - FIX.water.perPage * 2);
    expect(await get(4)).toEqual({ items: [], hasMore: false, page: 4 });

    const secret = await request.get(`/api/stream/forum/${FIX.staff.id}?page=1`);
    expect(secret.status()).toBe(404);
  });
});
