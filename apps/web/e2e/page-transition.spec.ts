import { expect, test, type Page } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { installTransitionProbe, readTransitions, resetTransitions } from "./support/vt";

/**
 * 页面级过渡（M10.7 Step 4b）：template.tsx 的 <ViewTransition> + <html data-nav> 选方向。
 * 用 support/vt.ts 采样浏览器真实播放的 ::view-transition-* 动画，而不是只断言 DOM。
 * 注意：浏览器前进 / 后退（popstate）不在这里断言动画——React 对 popstate 做同步急切提交，
 * 缓存命中时不走 View Transition（M10.7 §5.7），只断言它能正常工作且方向属性被清掉。
 */

const WATER = `/f/${FIX.water.id}`;
const topicLink = (page: Page) => page.locator("main a.font-medium[href^='/t/']").first();
const navAttr = (page: Page) => page.evaluate(() => document.documentElement.dataset.nav ?? null);

/** 打开列表并热身目标主题路由（dev 首次编译会让导航挂起很久） */
async function openWater(page: Page) {
  await installTransitionProbe(page);
  await page.goto(WATER);
  await expect(topicLink(page)).toBeVisible();
  const href = (await topicLink(page).getAttribute("href"))!;
  await page.request.get(href);
  await page.request.get("/boards");
  await page.request.get("/search");
  await page.waitForTimeout(500);
  return href;
}

test.describe("页面过渡：方向与动画", () => {
  test("前进（板块页 → 主题）：旧页向左退出、新页自右进入，方向属性在过渡结束后清除", async ({
    page,
  }) => {
    const href = await openWater(page);
    await resetTransitions(page);
    await topicLink(page).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect
      .poll(async () => (await readTransitions(page)).animations, { timeout: 5000 })
      .toEqual(
        expect.arrayContaining([
          "::view-transition-old(page)|vt-page-out-left",
          "::view-transition-new(page)|vt-page-in-right",
        ]),
      );
    expect((await readTransitions(page)).starts).toEqual(["push"]);
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();
  });

  test("返回（主题 → 首页链接）：旧页向右退出、新页自左进入", async ({ page }) => {
    await openWater(page);
    await topicLink(page).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);
    await expect.poll(() => navAttr(page)).toBeNull();
    await resetTransitions(page);
    await page.locator("header a[href='/']").first().click();
    await expect(page).toHaveURL(/\/$/);
    await expect
      .poll(async () => (await readTransitions(page)).animations, { timeout: 5000 })
      .toEqual(
        expect.arrayContaining([
          "::view-transition-old(page)|vt-page-out-right",
          "::view-transition-new(page)|vt-page-in-left",
        ]),
      );
    expect((await readTransitions(page)).starts).toEqual(["pop"]);
  });

  test("同级切换（板块目录 → 搜索）：淡出淡入，没有位移", async ({ page }) => {
    await installTransitionProbe(page);
    await page.goto("/boards");
    await page.request.get("/search");
    await page.waitForTimeout(500);
    await resetTransitions(page);
    await page.locator("header a[href='/search']").first().click();
    await expect(page).toHaveURL(/\/search/);
    await expect
      .poll(async () => (await readTransitions(page)).animations, { timeout: 5000 })
      .toEqual(
        expect.arrayContaining([
          "::view-transition-old(page)|vt-page-fade-out",
          "::view-transition-new(page)|vt-page-fade-in",
        ]),
      );
    const reading = await readTransitions(page);
    expect(reading.starts).toEqual(["fade"]);
    expect(reading.animations.some((a) => /out-left|out-right|in-left|in-right/.test(a))).toBe(
      false,
    );
  });

  test("仅查询串变化（板块页的前缀筛选）不触发页面过渡", async ({ page }) => {
    await installTransitionProbe(page);
    await page.goto(`/f/${FIX.anime.id}`);
    await page.waitForTimeout(500);
    await resetTransitions(page);
    await page.getByRole("link", { name: FIX.anime.prefixName, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`type=${FIX.anime.prefixId}`));
    await page.waitForTimeout(800);
    expect(await readTransitions(page)).toEqual({ starts: [], animations: [] });
    await expect.poll(() => navAttr(page)).toBeNull(); // 没有过渡也要清掉方向属性
  });

  test("慢导航：方向属性撑到页面提交，动画方向仍然正确", async ({ page }) => {
    const href = await openWater(page);
    await page.route(/\/t\/\d+/, async (route) => {
      const h = route.request().headers();
      if (h["rsc"] && !h["next-router-prefetch"]) await new Promise((r) => setTimeout(r, 1500));
      await route.continue().catch(() => {});
    });
    await resetTransitions(page);
    await topicLink(page).click();
    await page.waitForTimeout(600);
    expect(await navAttr(page)).toBe("push"); // 导航还挂着，方向属性必须还在
    await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 8000 });
    await expect
      .poll(async () => (await readTransitions(page)).animations)
      .toEqual(expect.arrayContaining(["::view-transition-old(page)|vt-page-out-left"]));
    expect((await readTransitions(page)).starts).toEqual(["push"]);
  });

  test("顶栏固定：被命名为独立过渡组，页面动画不带着它一起动", async ({ page }) => {
    await page.goto("/");
    const name = await page
      .locator("header")
      .first()
      .evaluate((el) => getComputedStyle(el).viewTransitionName);
    expect(name).toBe("fw-site-header");
  });
});

test.describe("页面过渡：降级与边界", () => {
  test("减少动态效果：导航照常完成，但没有任何页面过渡动画（明确决策）", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const href = await openWater(page);
    await resetTransitions(page);
    await topicLink(page).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await page.waitForTimeout(800);
    expect((await readTransitions(page)).animations).toEqual([]);
    await expect.poll(() => navAttr(page)).toBeNull();
  });

  test("浏览器返回键：能正常回到上一页，方向属性不残留", async ({ page }) => {
    await openWater(page);
    await topicLink(page).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${WATER}$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText("E2E 水区");
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();
  });

  test("导航失败（RSC 被拦）：留在原页，方向属性被清掉，不残留到下一次导航", async ({ page }) => {
    await openWater(page);
    await page.route(/\/t\/\d+/, (route) => {
      const h = route.request().headers();
      return h["rsc"] && !h["next-router-prefetch"] ? route.abort("failed") : route.continue();
    });
    await topicLink(page).click();
    await expect(page.locator("[data-sonner-toast]", { hasText: "加载失败，请重试" })).toBeVisible({
      timeout: 5000,
    });
    await expect(page).toHaveURL(new RegExp(`${WATER}$`));
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();
  });
});
