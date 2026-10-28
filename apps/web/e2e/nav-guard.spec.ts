import { expect, test, type Page } from "@playwright/test";
import { FIX } from "./support/fixtures";

/**
 * 导航守卫：慢网络与失败兜底（M10.7 Step 4a）。
 * 从水区列表点进主题页；用 Playwright 拦截 / 延迟 / 中止「导航型 RSC 请求」来模拟各种网络状况。
 * 整页文档请求（非 RSC）一律放行，所以失败后的「整页回退」能真实发生——守卫必须把它拦下。
 */

const LIST = `/f/${FIX.water.id}`;
const TOPIC_RSC = /\/t\/\d+/;

const firstTopicLink = (page: Page) => page.locator("main a.font-medium[href^='/t/']").first();
const progress = (page: Page) => page.getByRole("progressbar", { name: "页面加载中" });
const toastText = (page: Page, text: string) =>
  page.locator("[data-sonner-toast]", { hasText: text });

/** 延迟导航型 RSC 请求（预取与整页请求不受影响） */
async function delayRsc(page: Page, ms: number) {
  await page.route(TOPIC_RSC, async (route) => {
    const h = route.request().headers();
    if (h["rsc"] && !h["next-router-prefetch"]) await new Promise((r) => setTimeout(r, ms));
    await route.continue().catch(() => {});
  });
}

/** 水合完成的标志：给 window 打标记，之后若发生整页跳转标记会丢失 */
async function openListAndMark(page: Page) {
  await page.goto(LIST);
  await expect(firstTopicLink(page)).toBeVisible();
  // 热身目标路由，避免 dev 首次编译把计时搅乱
  const href = (await firstTopicLink(page).getAttribute("href"))!;
  await page.request.get(href, { headers: { rsc: "1" } });
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
  return href;
}
const markerAlive = (page: Page) =>
  page.evaluate(() => (window as unknown as { __marker?: number }).__marker === 1);

test.describe("慢网络：点击即反馈", () => {
  test("点击后很快出现进度条与 busy 态；重复点击不会重复发请求；页面提交后全部复位", async ({
    page,
  }) => {
    const href = await openListAndMark(page);
    await delayRsc(page, 1500);
    let rscRequests = 0;
    page.on("request", (r) => {
      const h = r.headers();
      if (h["rsc"] && !h["next-router-prefetch"] && r.url().includes(href)) rscRequests++;
    });

    const link = firstTopicLink(page);
    await link.click();
    await expect(progress(page)).toBeVisible({ timeout: 800 }); // 80ms 阈值，留足余量
    await expect(link).toHaveAttribute("data-nav-busy", "");
    // 用户心急连点：被去重
    await link.click({ force: true });
    await link.click({ force: true });

    await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 8000 });
    await expect(progress(page)).toHaveCount(0);
    expect(rscRequests).toBe(1);
  });

  test("超过 3 秒仍未返回：提示「网络较慢」；完成后提示自动收起", async ({ page }) => {
    const href = await openListAndMark(page);
    await delayRsc(page, 4500);
    await firstTopicLink(page).click();
    await expect(toastText(page, "网络较慢，仍在加载…")).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 8000 });
    await expect(toastText(page, "网络较慢，仍在加载…")).toHaveCount(0);
  });

  test("已缓存 / 很快的导航不闪进度条", async ({ page }) => {
    await openListAndMark(page);
    await firstTopicLink(page).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);
    await expect(progress(page)).toHaveCount(0);
  });
});

test.describe("失败兜底：提示并留在原页", () => {
  test("RSC 请求失败：不跳到浏览器错误页，页面与地址都留在列表，toast 提示失败", async ({
    page,
  }) => {
    await openListAndMark(page);
    await page.route(TOPIC_RSC, (route) => {
      const h = route.request().headers();
      return h["rsc"] && !h["next-router-prefetch"] ? route.abort("failed") : route.continue();
    });
    const link = firstTopicLink(page);
    await link.click();

    await expect(toastText(page, "加载失败，请重试")).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(new RegExp(`${LIST}$`));
    expect(await markerAlive(page)).toBe(true); // 没有发生整页跳转（window 标记还在）
    await expect(progress(page)).toHaveCount(0);
    await expect(link).not.toHaveAttribute("data-nav-busy", "");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("E2E 水区");
  });

  test("点「重试」：网络恢复后同一导航成功", async ({ page }) => {
    const href = await openListAndMark(page);
    await page.route(TOPIC_RSC, (route) => {
      const h = route.request().headers();
      return h["rsc"] && !h["next-router-prefetch"] ? route.abort("failed") : route.continue();
    });
    await firstTopicLink(page).click();
    await expect(toastText(page, "加载失败，请重试")).toBeVisible({ timeout: 5000 });

    await page.unroute(TOPIC_RSC); // 网络恢复
    await toastText(page, "加载失败，请重试").getByRole("button", { name: "重试" }).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 8000 });
    expect(await markerAlive(page)).toBe(true); // 重试走的是软导航
  });

  test("失败后路由器没有卡死：再点别的链接仍然正常软导航", async ({ page }) => {
    await openListAndMark(page);
    await page.route(TOPIC_RSC, (route) => {
      const h = route.request().headers();
      return h["rsc"] && !h["next-router-prefetch"] ? route.abort("failed") : route.continue();
    });
    await firstTopicLink(page).click();
    await expect(toastText(page, "加载失败，请重试")).toBeVisible({ timeout: 5000 });

    await page.getByRole("link", { name: "首页", exact: true }).first().click();
    await expect(page).toHaveURL(/\/$/);
    expect(await markerAlive(page)).toBe(true);
  });

  test("请求一直卡住：15 秒超时按失败处理，留在原页", async ({ page }) => {
    test.setTimeout(45_000);
    await openListAndMark(page);
    await delayRsc(page, 25_000);
    await firstTopicLink(page).click();
    await expect(toastText(page, "加载失败，请重试")).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`${LIST}$`));
    expect(await markerAlive(page)).toBe(true);
    await expect(progress(page)).toHaveCount(0);
  });

  test("已离线：点击前就提示，不发起导航", async ({ page, context }) => {
    await openListAndMark(page);
    await context.setOffline(true);
    try {
      await firstTopicLink(page).click();
      await expect(toastText(page, "网络已断开")).toBeVisible({ timeout: 3000 });
      await expect(page).toHaveURL(new RegExp(`${LIST}$`));
      await expect(progress(page)).toHaveCount(0);
    } finally {
      await context.setOffline(false);
    }
  });
});
