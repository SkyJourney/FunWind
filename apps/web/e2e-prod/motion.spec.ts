import { expect, test, type Page } from "@playwright/test";
import { installTransitionProbe, readTransitions, resetTransitions } from "../e2e/support/vt";

/**
 * 生产构建下的动效与导航兜底复验（M10.7 Step 4d）。
 * 开发服务器上的 E2E 证明不了这些：生产构建会预取视口内的链接、路由缓存行为不同、打包方式不同，
 * 导航常常瞬时完成——页面过渡、导航守卫、骨架屏在生产下是否依然成立，必须在真实 next build + next start 上实测。
 */

const navAttr = (page: Page) => page.evaluate(() => document.documentElement.dataset.nav ?? null);

/** 首页第一张内容卡片里的主题链接（e2e 夹具里首页有演示种子 + 夹具帖） */
const firstCardLink = (page: Page) => page.locator("main article h3 a").first();

test.describe("生产构建 · 页面过渡", () => {
  test("Tab 切换（首页 → 板块目录）在生产构建下播放 tab-next 动画，方向属性被清掉", async ({
    page,
  }) => {
    await installTransitionProbe(page);
    await page.goto("/");
    await expect(firstCardLink(page)).toBeVisible();
    await page.waitForTimeout(800); // 让视口内链接的预取完成：生产下导航通常是瞬时的
    await resetTransitions(page);
    await page.locator("header a[href='/boards']").first().click();
    await expect(page).toHaveURL(/\/boards/);
    await expect
      .poll(async () => (await readTransitions(page)).animations, { timeout: 5000 })
      .toEqual(
        expect.arrayContaining([
          "::view-transition-old(page)|vt-tab-out-left",
          "::view-transition-new(page)|vt-tab-in-right",
        ]),
      );
    expect((await readTransitions(page)).starts).toEqual(["tab-next"]);
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();
  });

  test("点内容卡片进主题页：圆形扩散；站内返回回到首页：同圆心收起", async ({ page }) => {
    await installTransitionProbe(page);
    await page.goto("/");
    const link = firstCardLink(page);
    await expect(link).toBeVisible();
    const box = (await link.boundingBox())!;
    await page.waitForTimeout(800);
    await resetTransitions(page);
    await page.mouse.click(box.x + 12, box.y + box.height / 2);
    await expect(page).toHaveURL(/\/t\/\d+/);
    await expect
      .poll(async () => (await readTransitions(page)).animations, { timeout: 8000 })
      .toEqual(expect.arrayContaining(["::view-transition-new(page)|vt-page-expand"]));
    expect((await readTransitions(page)).starts).toEqual(["expand"]);
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();

    await resetTransitions(page);
    await page.locator("header a[href='/']").first().click();
    await expect(page).toHaveURL(/\/$/);
    await expect
      .poll(async () => (await readTransitions(page)).animations, { timeout: 5000 })
      .toEqual(expect.arrayContaining(["::view-transition-old(page)|vt-page-collapse"]));
    expect((await readTransitions(page)).starts).toEqual(["collapse"]);
  });

  test("减少动态效果：生产构建下同样没有任何过渡动画，导航照常", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installTransitionProbe(page);
    await page.goto("/");
    await expect(firstCardLink(page)).toBeVisible();
    await page.waitForTimeout(800);
    await resetTransitions(page);
    await firstCardLink(page).click();
    await expect(page).toHaveURL(/\/t\/\d+/);
    await page.waitForTimeout(800);
    expect((await readTransitions(page)).animations).toEqual([]);
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();
  });
});

test.describe("生产构建 · 导航守卫（慢网络与失败兜底）", () => {
  /** 让导航型 RSC 请求失败；返回处理函数，之后用同一个引用精确移除（新的正则字面量不会被 Playwright 认作同一个路由） */
  async function failThreadNavigation(page: Page) {
    const handler = (route: import("@playwright/test").Route) => {
      const h = route.request().headers();
      return h["rsc"] && !h["next-router-prefetch"] ? route.abort("failed") : route.continue();
    };
    await page.route(/\/t\/\d+/, handler);
    return handler;
  }
  const failureToast = (page: Page) =>
    page.locator("[data-sonner-toast]", { hasText: "加载失败，请重试" });

  test("RSC 请求失败：不跳到浏览器错误页，页面与地址留在原页，toast 提示失败，方向属性被清掉", async ({
    page,
  }) => {
    const reactErrors: string[] = [];
    page.on("console", (m) => {
      if (/Cannot update a component|while rendering a different component/.test(m.text())) {
        reactErrors.push(m.text().slice(0, 160));
      }
    });
    await page.goto("/");
    await expect(firstCardLink(page)).toBeVisible();
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    await failThreadNavigation(page);
    await firstCardLink(page).click();
    await expect(failureToast(page)).toBeVisible({ timeout: 8000 });
    await expect(page).toHaveURL(/\/$/);
    // 没有发生整页跳转（window 上的标记还在）
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(
      1,
    );
    await expect(page.getByRole("progressbar", { name: "页面加载中" })).toHaveCount(0);
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();
    expect(reactErrors).toEqual([]);
  });

  test("失败后点 toast 的「重试」：网络恢复后同一导航成功（生产构建下路由器需要先重置，否则永远挂起）", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(firstCardLink(page)).toBeVisible();
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    const handler = await failThreadNavigation(page);
    await firstCardLink(page).click();
    await expect(failureToast(page)).toBeVisible({ timeout: 8000 });

    await page.unroute(/\/t\/\d+/, handler); // 网络恢复
    await failureToast(page).getByRole("button", { name: "重试" }).click();
    await expect(page).toHaveURL(/\/t\/\d+/, { timeout: 8000 });
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(
      1,
    ); // 软导航
  });

  test("失败后用户再点一次同一张卡片（最自然的重试）：同样成功", async ({ page }) => {
    await page.goto("/");
    await expect(firstCardLink(page)).toBeVisible();
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    const handler = await failThreadNavigation(page);
    await firstCardLink(page).click();
    await expect(failureToast(page)).toBeVisible({ timeout: 8000 });

    await page.unroute(/\/t\/\d+/, handler);
    await firstCardLink(page).click();
    await expect(page).toHaveURL(/\/t\/\d+/, { timeout: 8000 });
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(
      1,
    );
  });

  test("失败后点别的链接：路由器没有卡死，正常软导航", async ({ page }) => {
    await page.goto("/");
    await expect(firstCardLink(page)).toBeVisible();
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    await failThreadNavigation(page);
    await firstCardLink(page).click();
    await expect(failureToast(page)).toBeVisible({ timeout: 8000 });
    await page.locator("header a[href='/boards']").first().click();
    await expect(page).toHaveURL(/\/boards/, { timeout: 8000 });
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(
      1,
    );
  });

  test("慢导航：点击立刻出现进度条与 busy 态，重复点击不重复发请求，3 秒后提示网络较慢", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(firstCardLink(page)).toBeVisible();
    let rscRequests = 0;
    page.on("request", (r) => {
      const h = r.headers();
      if (h["rsc"] && !h["next-router-prefetch"] && /\/t\/\d+/.test(r.url())) rscRequests++;
    });
    await page.route(/\/t\/\d+/, async (route) => {
      const h = route.request().headers();
      if (h["rsc"] && !h["next-router-prefetch"]) await new Promise((r) => setTimeout(r, 3600));
      await route.continue().catch(() => {});
    });
    const link = firstCardLink(page);
    await link.click();
    await expect(page.getByRole("progressbar", { name: "页面加载中" })).toBeVisible({
      timeout: 1000,
    });
    await expect(page.locator("main article[data-nav-busy]")).toHaveCount(1);
    await link.click({ force: true });
    await link.click({ force: true });
    await expect(
      page.locator("[data-sonner-toast]", { hasText: "网络较慢，仍在加载…" }),
    ).toBeVisible({
      timeout: 5000,
    });
    await expect(page).toHaveURL(/\/t\/\d+/, { timeout: 10_000 });
    expect(rscRequests).toBe(1);
    await expect(
      page.locator("[data-sonner-toast]", { hasText: "网络较慢，仍在加载…" }),
    ).toHaveCount(0);
  });
});

test.describe("生产构建 · 板块目录骨架", () => {
  test("loading 边界下 .sk 占位条有底色与动画；真实内容出现后骨架消失", async ({ page }) => {
    // 骨架在生产下依然带样式（.sk 曾从未被定义，占位条是透明的）：直接核对样式表里该类的计算结果
    await page.goto("/boards");
    await expect(page.getByRole("heading", { level: 1, name: "板块目录" })).toBeVisible();
    const sk = await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "sk";
      document.body.append(el);
      const cs = getComputedStyle(el);
      const out = { bg: cs.backgroundColor, anim: cs.animationName };
      el.remove();
      return out;
    });
    expect(sk.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(sk.anim).toBe("fw-sk-pulse");
    await expect(page.locator(".sk")).toHaveCount(0); // 数据已到：骨架不残留
  });
});
