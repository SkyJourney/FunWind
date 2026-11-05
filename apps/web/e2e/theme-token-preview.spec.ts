import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * M11.6 Step 3d：令牌预览与对比度检查在真浏览器里的几条承诺。jsdom 不算 CSS 级联、不排版，只能在这里验：
 *  · 预览不受后台页面明暗影响（容器自己带全量变量，不从页面继承）；
 *  · 品牌渐变在预览容器里跟着草稿的主色走（semantic.css 里 `[data-token-preview]` 选择器的作用）；
 *  · 大屏上预览吸顶、贴着页头下沿，小屏不吸顶；
 *  · 吸顶预览挡住目标行时，「定位」会再多滚一段，行落在预览下面。
 * 只改浏览器里的草稿，不点保存，不动库。
 */
failOnPageErrors();

const PREVIEW_ID = "token-preview";

async function openEditor(
  page: Page,
  context: BrowserContext,
  size: { width: number; height: number },
) {
  await loginAs(context, USERS.admin);
  await page.setViewportSize(size);
  await page.goto("/admin/themes/default");
  // 保存按钮在水合之后才可用：用它判断页面已经可以交互
  await expect(page.getByRole("button", { name: "保存主题包" })).toBeEnabled();
  await page.getByTestId("theme-token-editor").locator("summary").click();
  await expect(page.getByTestId(PREVIEW_ID)).toBeVisible();
}

const stickyWrapper = (page: Page) => page.getByTestId(PREVIEW_ID).locator("xpath=../..");

/** #rrggbb → Chromium 计算样式里的 rgb(r, g, b) */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

test("预览不受后台页面明暗影响：页面是深色时浅色档仍是浅色底，页面是浅色时深色档仍是深色底", async ({
  page,
  context,
}) => {
  await openEditor(page, context, { width: 1280, height: 800 });
  const preview = page.getByTestId(PREVIEW_ID);
  const ownBackground = () =>
    preview.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--background").trim());
  const paintedBackground = () => preview.evaluate((el) => getComputedStyle(el).backgroundColor);
  const pageBackground = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    );

  const lightOwn = await ownBackground();
  const lightPage = await pageBackground();
  expect(await paintedBackground()).toBe(rgb(lightOwn));

  // 把页面切成深色（与 code-highlight.spec 同一写法）；预览画出来的底色不变
  await page.evaluate(() => document.documentElement.setAttribute("data-mode", "dark"));
  expect(await pageBackground(), "页面确实变成了深色").not.toBe(lightPage);
  expect(await paintedBackground()).toBe(rgb(lightOwn));

  // 编辑器切到深色档并启用深色令牌：预览换成深色底，页面此时是深色
  await page
    .getByRole("group", { name: "颜色模式" })
    .getByRole("button", { name: "深色档" })
    .click();
  await page.getByRole("button", { name: "启用深色令牌", exact: true }).click();
  await expect(preview).toHaveAttribute("data-preview-mode", "dark");
  const darkOwn = await ownBackground();
  expect(darkOwn).not.toBe(lightOwn);
  expect(await paintedBackground()).toBe(rgb(darkOwn));

  // 页面切回浅色：深色档预览仍是深色底
  await page.evaluate(() => document.documentElement.setAttribute("data-mode", "light"));
  expect(await pageBackground()).toBe(lightPage);
  expect(await paintedBackground()).toBe(rgb(darkOwn));
});

test("品牌渐变在预览容器里跟着草稿的主色走，页面自己的渐变不变", async ({ page, context }) => {
  await openEditor(page, context, { width: 1280, height: 800 });
  const swatch = page.getByTestId(PREVIEW_ID).locator('[class*="gradient-brand"]').first();
  const gradient = () => swatch.evaluate((el) => getComputedStyle(el).backgroundImage);
  const pageGradient = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--gradient-brand").trim(),
    );

  const before = await gradient();
  const pageBefore = await pageGradient();
  await page.getByRole("button", { name: "主色：覆盖", exact: true }).click();
  await page.getByRole("textbox", { name: "主色（全站）", exact: true }).fill("#ff0000");

  // var() 在声明它的元素上取值：semantic.css 的 `[data-token-preview]` 选择器让容器自己重新算一遍
  const after = await gradient();
  expect(after).not.toBe(before);
  expect(after).toContain("color(srgb 1 0 0 / 0.15)");
  expect(await pageGradient(), "草稿不会漏到页面上").toBe(pageBefore);
});

test("大屏上预览吸顶并贴着页头下沿，小屏不吸顶", async ({ page, context }) => {
  await openEditor(page, context, { width: 1280, height: 800 });
  const wrapper = stickyWrapper(page);
  const position = () => wrapper.evaluate((el) => getComputedStyle(el).position);
  expect(await position()).toBe("sticky");

  // 滚到颜色列表的最后一行：包裹层应当吸在页头下沿，既没有缝，也没被页头盖住一大截
  await page.getByRole("button", { name: "焦点环：覆盖", exact: true }).scrollIntoViewIfNeeded();
  const header = (await page.locator('header[data-surface="header"]').boundingBox())!;
  const box = (await wrapper.boundingBox())!;
  expect(box.y).toBeLessThanOrEqual(header.y + header.height);
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 3);

  // 吸顶区不能吃掉大半个视口，否则下面的项就没法改了；实际高度记进报告
  test.info().annotations.push({ type: "预览吸顶区高度", description: `${box.height}px` });
  expect(box.height).toBeLessThan(400);

  await page.setViewportSize({ width: 1000, height: 800 });
  expect(await position()).toBe("static");
});

test("吸顶预览挡住目标行时，「定位」多滚一段，行落在预览下面并拿到焦点", async ({
  page,
  context,
}) => {
  await openEditor(page, context, { width: 1280, height: 800 });
  const wrapper = stickyWrapper(page);
  const stickyHeight = (await wrapper.boundingBox())!.height;
  // 视口高度按预览的实际高度算：页头 56 + 预览 + 150px 的可见余地。
  // 这样视口中线（高度的一半）一定落在预览下沿之上，滚到「中间」的行必然被预览盖住
  const height = Math.round(56 + stickyHeight + 150);
  await page.setViewportSize({ width: 1280, height });

  await page.evaluate(() => {
    const w = window as unknown as { __scrollByCalls: number };
    w.__scrollByCalls = 0;
    const original = window.scrollBy.bind(window);
    window.scrollBy = ((...args: Parameters<typeof window.scrollBy>) => {
      w.__scrollByCalls += 1;
      return original(...args);
    }) as typeof window.scrollBy;
  });

  await page.getByRole("button", { name: "主色文字 / 主色淡底（页面）：定位页面底" }).click();

  const calls = await page.evaluate(
    () => (window as unknown as { __scrollByCalls: number }).__scrollByCalls,
  );
  expect(calls, "预览盖住了目标行，应当修正一次").toBe(1);
  const row = (await page.locator('[data-token-key="background"]').boundingBox())!;
  const sticky = (await wrapper.boundingBox())!;
  expect(row.y).toBeGreaterThanOrEqual(sticky.y + sticky.height);
  expect(row.y + row.height).toBeLessThanOrEqual(height);
  await expect(page.getByRole("button", { name: "页面底：覆盖", exact: true })).toBeFocused();
});
