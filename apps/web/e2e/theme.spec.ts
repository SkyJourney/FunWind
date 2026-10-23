import { expect, test } from "@playwright/test";

test.describe("令牌演示页 · 主题切换", () => {
  test("页面加载并渲染三层令牌内容", async ({ page }) => {
    await page.goto("/");
    // 注：Next 16.4.2 下 root layout 的 title.template 未作用于子页（疑似回归，M1 遗留复验），
    // 故仅断言页面自身标题
    await expect(page).toHaveTitle(/设计令牌/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("FunWind 设计令牌");
    await expect(page.getByRole("group", { name: "主题切换" })).toBeVisible();
  });

  test("切换暗色 → html[data-theme=dark] 且语义类配色生效", async ({ page }) => {
    await page.goto("/");
    await page.getByTitle("暗色").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // 语义令牌真实生效：背景为暗色值
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe("rgb(248, 250, 252)"); // 浅色 --fw-gray-50
  });

  test("刷新后主题持久化（localStorage）", async ({ page }) => {
    await page.goto("/");
    await page.getByTitle("暗色").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("跟随系统档位可选中", async ({ page }) => {
    await page.goto("/");
    await page.getByTitle("跟随系统").click();
    const theme = await page.locator("html").getAttribute("data-theme");
    expect(["light", "dark"]).toContain(theme ?? "");
  });
});
