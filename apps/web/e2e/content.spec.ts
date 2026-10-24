import { expect, test } from "@playwright/test";

/**
 * 内容只读渲染 E2E（schema v2.1 迁移数据 + 演示夹具）。固定夹具（迁移产出是确定的，每轮重建）：
 *   tid 6      会计用语：含历史表情码（迁移后展开为 /emoji/{id}.gif 静态图）
 *   tid 47     空之音：正文含 /files/ 内容寻址图片
 *   tid 25     占位作者（原作者账号已不存在 → “已注销用户”占位账号）
 *   tid 95     投票帖
 *   fid 109    动画（有主题前缀 48“连载中”）
 *   fid 151    水区：非置顶可见主题 225 个 → 每页 25 条共 9 页；另有 1 个版块置顶；全站置顶 8 个
 *   tid 96 / 3500  旧站里在已删除版块 / 是垃圾空壳的主题——迁移不迁，应为 404
 */

test.describe("内容只读渲染", () => {
  test("首页 → 版块目录 → 版块页 → 帖子详情", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("青翼字幕组");
    await expect(page.getByText("最新动态")).toBeVisible();

    await page.getByRole("link", { name: "『动画 · アニメ』" }).first().click();
    await expect(page).toHaveURL(/\/f\/109/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("アニメ");

    await page.goto("/t/6621");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("刀剣乱舞");
    await expect(page.getByText("回帖", { exact: false })).toBeVisible();
  });

  test("历史表情码展开为 /emoji/ 静态图，且图片真实加载", async ({ page }) => {
    await page.goto("/t/6");
    const emo = page.locator('.content-md img[src^="/emoji/"]').first();
    await expect(emo).toHaveCount(1);
    // 图片是 loading="lazy"，在首屏之外时宽高为 0：先滚到视口内再断言真实加载
    await emo.evaluate((el) => el.scrollIntoView());
    await expect
      .poll(() => emo.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  });

  test("正文图片走 /files/ 内容寻址地址，游客可见且真实加载（200 + 正确类型）", async ({
    page,
  }) => {
    await page.goto("/t/47");
    const img = page.locator('.content-md img[src^="/files/"]').first();
    await expect(img).toHaveCount(1);
    await img.evaluate((el) => el.scrollIntoView());
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    const res = await page.request.get((await img.getAttribute("src"))!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^image\//);
  });

  test("旧站已删除版块 / 垃圾空壳里的主题没有迁移 → 404", async ({ page }) => {
    for (const tid of [96, 3500]) {
      const res = await page.goto(`/t/${tid}`);
      expect(res?.status(), `tid ${tid}`).toBe(404);
    }
  });

  test("原作者账号已不存在 → 显示「已注销」，没有指向个人页的链接", async ({ page }) => {
    await page.goto("/t/25");
    await expect(page.getByText("已注销").first()).toBeVisible();
    await expect(page.locator("header").getByRole("link", { name: "已注销" })).toHaveCount(0);
    // 占位账号不开个人页
    const res = await page.goto("/u/1");
    expect(res?.status()).toBe(404);
  });

  test("投票帖徽标", async ({ page }) => {
    await page.goto("/t/95");
    await expect(page.getByText("投票帖")).toBeVisible();
  });

  test("版块分页：水区 225 个非置顶主题 → 9 页，page=2 可达，越界页码被夹到最后一页", async ({
    page,
  }) => {
    await page.goto("/f/151");
    await expect(page.getByText(/共 225 个主题 · 第 1\/9 页/)).toBeVisible();
    await page.goto("/f/151?page=2");
    await expect(page.getByText(/第 2\/9 页/)).toBeVisible();
    await page.goto("/f/151?page=999");
    await expect(page.getByText(/第 9\/9 页/)).toBeVisible();
  });

  test("置顶块：只在第 1 页，全站置顶 8 个（跨版块）+ 本版块置顶，不重复进入普通列表", async ({
    page,
  }) => {
    await page.goto("/f/151");
    const pinned = page.getByRole("region", { name: "置顶主题" });
    await expect(pinned).toBeVisible();
    await expect(pinned.getByText("全站置顶", { exact: true })).toHaveCount(8);
    const firstPinnedTitle = await pinned.locator('a[href^="/t/"]').first().innerText();

    await page.goto("/f/151?page=2");
    await expect(page.getByRole("region", { name: "置顶主题" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: firstPinnedTitle, exact: true })).toHaveCount(0);
  });

  test("主题分类筛选", async ({ page }) => {
    await page.goto("/f/109");
    await page.getByRole("link", { name: "连载中", exact: true }).click();
    await expect(page).toHaveURL(/type=48/);
  });

  test("移动视口 375px smoke", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto("/t/6621");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
