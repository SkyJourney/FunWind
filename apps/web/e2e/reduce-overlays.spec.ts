import { expect, test, type Page } from "@playwright/test";

/**
 * 弹层动效 × 减弱动效（M16 Step 1，docs/motion-spec.md §6 第 5 条）：
 * tw-animate-css 自身无 reduce 规则，globals.css 全局兜底把 animate-in/out 归零。
 * 断言用 computed animationName（静态取自 CSS 规则），与动画播放时序无关，确定性。
 * reduce 用例即 G-16 的降级路径。
 */

const menu = (page: Page) => page.getByRole("menu");
const hoverCard = (page: Page) => page.locator("[data-radix-popper-content-wrapper] > div").first();

async function animationName(
  page: Page,
  locator: ReturnType<Page["getByRole"]> | ReturnType<Page["locator"]>,
) {
  return locator.evaluate((el) => getComputedStyle(el).animationName);
}

test.describe("主题下拉 × reduce", () => {
  test("正常动效：展开动画为 tw-animate enter", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "主题切换" }).click();
    await expect(menu(page)).toBeVisible();
    expect(await animationName(page, menu(page))).toBe("enter");
  });

  test("reduce：动画归零（内容直接呈现）", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByRole("button", { name: "主题切换" }).click();
    await expect(menu(page)).toBeVisible();
    expect(await animationName(page, menu(page))).toBe("none");
  });
});

test.describe("用户悬浮名片 × reduce", () => {
  const authorLink = (page: Page) => page.locator('main a[href^="/u/"]').first();

  test("正常动效：名片淡入为 tw-animate enter", async ({ page }) => {
    await page.goto("/t/900001");
    await authorLink(page).hover();
    const card = hoverCard(page);
    await expect(card).toBeVisible();
    expect(await animationName(page, card)).toBe("enter");
  });

  test("reduce：动画归零", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/t/900001");
    await authorLink(page).hover();
    const card = hoverCard(page);
    await expect(card).toBeVisible();
    expect(await animationName(page, card)).toBe("none");
  });
});
