import { expect, test } from "@playwright/test";

/**
 * 首页右栏独立滚动区（M10.7 站长反馈）：原先右栏只有 sticky，内容高于视口时页面滚动它却贴在原处，
 * 下面的内容（热门板块等）永远滚不出来。现限制最大高度并允许自身滚动。
 */

const aside = (page: import("@playwright/test").Page) => page.locator('aside[aria-label="侧栏"]');

test.describe("首页右栏 · 矮视口（xl 宽、高度不足）", () => {
  test.use({ viewport: { width: 1400, height: 520 } });

  test("右栏可独立滚动，滚到底最后一块内容完整出现在视口内（修复前永远看不到）", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(aside(page)).toBeVisible();
    const m = await aside(page).evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
      innerHeight: window.innerHeight,
    }));
    expect(m.overflowY).toBe("auto");
    expect(m.scrollHeight).toBeGreaterThan(m.clientHeight + 1); // 内容确实比可视区高
    expect(m.clientHeight).toBeLessThanOrEqual(m.innerHeight - 96); // 受 max-h 限制，不撑出视口

    // 先把页面滚下去，让 sticky 生效（未滚动时右栏停在自然位置，距顶约 170px，其下半部分本来就要靠滚动页面才进入视口）
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect
      .poll(() => aside(page).evaluate((el) => Math.round(el.getBoundingClientRect().top)))
      .toBeLessThanOrEqual(100);
    await aside(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    const bottoms = await aside(page).evaluate((el) => {
      const last = el.lastElementChild as HTMLElement;
      return { lastBottom: last.getBoundingClientRect().bottom, innerHeight: window.innerHeight };
    });
    expect(bottoms.lastBottom).toBeLessThanOrEqual(bottoms.innerHeight); // 滚到底后最后一块在视口内
  });

  test("右栏滚到头不会把滚动传给主列表（overscroll-contain）", async ({ page }) => {
    await page.goto("/");
    expect(await aside(page).evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe(
      "contain",
    );
  });

  test("加了内边距与负外边距后，右栏顶部仍与主列表顶部对齐（±2px）", async ({ page }) => {
    await page.goto("/");
    const delta = await page.evaluate(() => {
      const a = document.querySelector('aside[aria-label="侧栏"]')!;
      const first = a.firstElementChild!.getBoundingClientRect().top;
      const main = (a.previousElementSibling as HTMLElement).getBoundingClientRect().top;
      return Math.abs(first - main);
    });
    expect(delta).toBeLessThanOrEqual(2);
  });
});

test.describe("首页右栏 · 高视口", () => {
  test.use({ viewport: { width: 1400, height: 1800 } });

  test("内容放得下时不出现滚动", async ({ page }) => {
    await page.goto("/");
    const m = await aside(page).evaluate((el) => ({ s: el.scrollHeight, c: el.clientHeight }));
    expect(m.s).toBeLessThanOrEqual(m.c + 1);
  });
});

test.describe("首页右栏 · 窄屏", () => {
  test.use({ viewport: { width: 1000, height: 700 } });

  test("低于 xl 断点时右栏隐藏", async ({ page }) => {
    await page.goto("/");
    await expect(aside(page)).toBeHidden();
  });
});
