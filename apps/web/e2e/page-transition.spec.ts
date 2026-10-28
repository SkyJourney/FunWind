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
/** 页面包装盒子（template.tsx 的 [data-fw-page]）的文档顶部位置 = 顶栏等 chrome 的高度 */
const pageTopOf = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector("[data-fw-page]")!;
    return Math.round(el.getBoundingClientRect().top + window.scrollY);
  });
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
  test("前进（首页 → 板块目录，顶栏链接）：旧页向左退出、新页自右进入，方向属性在过渡结束后清除", async ({
    page,
  }) => {
    await installTransitionProbe(page);
    await page.goto("/");
    await page.request.get("/boards");
    await page.waitForTimeout(500);
    await resetTransitions(page);
    await page.locator("header a[href='/boards']").first().click();
    await expect(page).toHaveURL(/\/boards/);
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
    expect(await readTransitions(page)).toEqual({ starts: [], origins: [], animations: [] });
    await expect.poll(() => navAttr(page)).toBeNull(); // 没有过渡也要清掉方向属性
  });

  test("慢导航：方向属性与圆心撑到页面提交，扩散动画照常播放", async ({ page }) => {
    const href = await openWater(page);
    await page.route(/\/t\/\d+/, async (route) => {
      const h = route.request().headers();
      if (h["rsc"] && !h["next-router-prefetch"]) await new Promise((r) => setTimeout(r, 1500));
      await route.continue().catch(() => {});
    });
    await resetTransitions(page);
    await topicLink(page).click();
    await page.waitForTimeout(600);
    expect(await navAttr(page)).toBe("expand"); // 导航还挂着，方向属性必须还在
    await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 8000 });
    await expect
      .poll(async () => (await readTransitions(page)).animations)
      .toEqual(expect.arrayContaining(["::view-transition-new(page)|vt-page-expand"]));
    expect((await readTransitions(page)).starts).toEqual(["expand"]);
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

test.describe("触点扩散与收起（内容卡片 → 主题页）", () => {
  test("点击内容卡片进主题页：新页以点击点为圆心圆形展开，旧页静止垫底", async ({ page }) => {
    const href = await openWater(page);
    await resetTransitions(page);
    const box = (await topicLink(page).boundingBox())!;
    const click = { x: Math.round(box.x + 20), y: Math.round(box.y + box.height / 2) };
    const pageTop = await pageTopOf(page);
    await page.mouse.click(click.x, click.y);
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect
      .poll(async () => (await readTransitions(page)).animations, { timeout: 5000 })
      .toEqual(expect.arrayContaining(["::view-transition-new(page)|vt-page-expand"]));
    const reading = await readTransitions(page);
    expect(reading.starts).toEqual(["expand"]);
    // 圆心 = 点击点相对页面包装盒子的坐标（盒子左边为 0，顶部 = 顶栏高度 pageTop）
    expect(reading.origins[0]).toMatchObject({ x: `${click.x}px`, y: `${click.y - pageTop}px` });
    // 旧页静止垫底：没有退场动画
    expect(reading.animations.some((a) => a.startsWith("::view-transition-old(page)"))).toBe(false);
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();
  });

  test("用站内链接回到打开它的列表页：详情页以同一圆心收起，列表页静止垫底", async ({ page }) => {
    await installTransitionProbe(page);
    await page.goto("/");
    const link = page.locator("main article h3 a").first();
    const href = (await link.getAttribute("href"))!;
    await page.request.get(href);
    await page.waitForTimeout(500);
    const box = (await link.boundingBox())!;
    const click = { x: Math.round(box.x + 10), y: Math.round(box.y + box.height / 2) };
    const pageTop = await pageTopOf(page);
    await page.mouse.click(click.x, click.y);
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();

    await resetTransitions(page);
    await page.locator("header a[href='/']").first().click();
    await expect(page).toHaveURL(/\/$/);
    await expect
      .poll(async () => (await readTransitions(page)).animations, { timeout: 5000 })
      .toEqual(expect.arrayContaining(["::view-transition-old(page)|vt-page-collapse"]));
    const reading = await readTransitions(page);
    expect(reading.starts).toEqual(["collapse"]);
    // 详情页停在顶部（scrollY 0）：与扩散时同一个圆心
    expect(reading.origins[0]).toMatchObject({ x: `${click.x}px`, y: `${click.y - pageTop}px` });
    expect(reading.animations.some((a) => a.startsWith("::view-transition-new(page)"))).toBe(false);
  });

  test("遮罩真实生效：扩散中途圆的半径还明显小于终点半径，且新页包装自带不透明背景", async ({
    page,
  }) => {
    await openWater(page);
    // 包装 div 必须有不透明背景：快照只含包装，body 背景在 root，没有它圆内会透出旧页
    const bg = await page.evaluate(
      () => getComputedStyle(document.querySelector("[data-fw-page]")!).backgroundColor,
    );
    expect(bg).not.toMatch(/rgba\(.*,\s*0\)$|transparent/);
    // 在页面里装探针：扩散动画走到 150ms 时，读伪元素当前的 clip-path 半径
    await page.evaluate(() => {
      const w = window as unknown as { __mid?: { now: number; end: number } };
      const tick = () => {
        const a = document
          .getAnimations()
          .find(
            (x) =>
              (x.effect as KeyframeEffect | null)?.pseudoElement?.startsWith(
                "::view-transition-new(",
              ) && (x as CSSAnimation).animationName === "vt-page-expand",
          );
        if (a && Number(a.currentTime) >= 150) {
          const pseudo = (a.effect as KeyframeEffect).pseudoElement!;
          const clip = getComputedStyle(document.documentElement, pseudo).clipPath;
          w.__mid = {
            now: parseFloat(/circle\(([\d.]+)px/.exec(clip)?.[1] ?? "NaN"),
            end: parseFloat(document.documentElement.style.getPropertyValue("--vt-r")),
          };
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await topicLink(page).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __mid?: unknown }).__mid), {
        timeout: 8000,
      })
      .toBeTruthy();
    const mid = await page.evaluate(
      () => (window as unknown as { __mid: { now: number; end: number } }).__mid,
    );
    // 回归：半径曾因百分比 + expo 缓动在 ~100ms 内就盖满视口，肉眼只看到淡入。中途（150ms / 500ms）圆必须还明显小于终点
    expect(mid.now).toBeGreaterThan(0);
    expect(mid.now).toBeLessThan(mid.end * 0.85);
  });

  test("卡片在第一屏之外（滚得很深才点）：回去时退化为普通 pop 滑动，不缩向空白", async ({
    page,
  }) => {
    await installTransitionProbe(page);
    await page.goto(WATER);
    await expect(topicLink(page)).toBeVisible();
    const row = page.locator("main a.font-medium[href^='/t/']").nth(20);
    const href = (await row.getAttribute("href"))!;
    await page.request.get(href);
    await row.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 400)); // 保证文档位置远在第一屏之外
    await row.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();
    await resetTransitions(page);
    await page.locator("header a[href='/']").first().click();
    await expect(page).toHaveURL(/\/$/);
    expect((await readTransitions(page)).starts).toEqual(["pop"]);
  });

  test("卡片里的其它链接（板块名）不扩散，是普通前进", async ({ page }) => {
    await installTransitionProbe(page);
    await page.goto("/");
    const forumLink = page.locator("main article a[href^='/f/']").first();
    await expect(forumLink).toBeVisible();
    await page.request.get((await forumLink.getAttribute("href"))!);
    await page.waitForTimeout(500);
    await resetTransitions(page);
    await forumLink.click();
    await expect(page).toHaveURL(/\/f\/\d+/);
    await expect
      .poll(async () => (await readTransitions(page)).starts, { timeout: 5000 })
      .toEqual(["push"]);
  });

  test("减少动态效果下点卡片：导航照常，没有任何过渡动画，圆心属性也被清掉", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const href = await openWater(page);
    await resetTransitions(page);
    await topicLink(page).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await page.waitForTimeout(800);
    expect((await readTransitions(page)).animations).toEqual([]);
    await expect.poll(() => navAttr(page), { timeout: 3000 }).toBeNull();
    expect(
      await page.evaluate(() => document.documentElement.style.getPropertyValue("--vt-x")),
    ).toBe("");
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
