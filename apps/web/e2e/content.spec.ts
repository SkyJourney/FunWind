import { expect, test } from "@playwright/test";

/**
 * 真实数据 E2E（夹具来自 2026-10-23 实测，见 docs/milestones/M3）：
 * tid 6621 刀剣乱舞（可读）/ 3007 spam 空壳 / 96 屏蔽（status=1）/ 121 孤儿作者回帖
 * tid 6623 [s:158] 表情（/emotion/02/26.gif）/ 151 尼斯湖水区 230 主题（分页）/ 121 有分类
 */

test.describe("M3 · 内容只读渲染", () => {
  test("首页 → 版块目录 → 版块页 → 帖子详情 → 楼层锚点", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("青翼字幕组");
    await expect(page.getByText("最新动态")).toBeVisible();

    await page.getByRole("link", { name: "『动画 · アニメ』" }).first().click();
    await expect(page).toHaveURL(/\/f\/109/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("アニメ");

    // 刀剣乱舞（tid 6621）按最后回帖排序不在第 1 页：直接访问详情验证楼层
    await page.goto("/t/6621");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("刀剣乱舞");
    await expect(page.getByText("回帖", { exact: false })).toBeVisible();
  });

  test("表情图真实渲染（[s:158] → /emotion/02/26.gif）", async ({ page }) => {
    await page.goto("/t/6623");
    const emo = page.locator('.content-md img[src="/emotion/02/26.gif"]');
    await expect(emo).toHaveCount(1);
  });

  test("spam 空壳帖（tid 3500）→ 404", async ({ page }) => {
    const res = await page.goto("/t/3500");
    expect(res?.status()).toBe(404);
  });

  test("屏蔽帖 → blocked 视图（保留 tid 语义）", async ({ page }) => {
    await page.goto("/t/96");
    await expect(page.getByText("该内容已被屏蔽或审核中")).toBeVisible();
  });

  test("孤儿作者 → 「已注销」渲染", async ({ page }) => {
    await page.goto("/t/121");
    await expect(page.getByText("已注销").first()).toBeVisible();
  });

  test("投票帖徽标（special=poll）", async ({ page }) => {
    await page.goto("/t/95");
    await expect(page.getByText("投票帖")).toBeVisible();
  });

  test("版块分页：尼斯湖水区 230 主题 → 10 页，page=2 可达", async ({ page }) => {
    await page.goto("/f/151");
    await expect(page.getByText(/第 1\/10 页/)).toBeVisible();
    await page.goto("/f/151?page=2");
    await expect(page.getByText(/第 2\/10 页/)).toBeVisible();
  });

  test("主题分类筛选（字幕制作组 type=59 招募）", async ({ page }) => {
    await page.goto("/f/121");
    await page.getByRole("link", { name: "招募", exact: true }).click();
    await expect(page).toHaveURL(/type=59/);
  });

  test("移动视口 375px smoke", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto("/t/6621");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
