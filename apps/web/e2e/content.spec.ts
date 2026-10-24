import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";

/**
 * 内容只读渲染 E2E（演示种子 + E2E 专用夹具，不依赖真实迁移数据）。夹具见 support/fixtures.ts：
 *   anime 951  公开版块，带主题前缀「连载中」；内含表情帖 / 正文图片帖 / 已注销作者帖 / 投票帖 / 已删除主题 / 3 个全站置顶
 *   water 952  60 个普通主题 → 每页 25 条共 3 页；另有 1 个版块置顶
 */

test.describe("内容只读渲染", () => {
  test("首页 → 版块目录 → 版块页 → 帖子详情", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("青翼字幕组");
    await expect(page.getByText("最新动态")).toBeVisible();

    await page.getByRole("link", { name: FIX.anime.name }).first().click();
    await expect(page).toHaveURL(new RegExp(`/f/${FIX.anime.id}`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText("E2E 动画");

    await page.goto(`/t/${FIX.thread.emoji}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("E2E 表情帖");
    await expect(page.getByText("历史表情码展开后的静态图")).toBeVisible();
  });

  test("历史表情码展开为 /emoji/ 静态图，且图片真实加载", async ({ page }) => {
    await page.goto(`/t/${FIX.thread.emoji}`);
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
    await page.goto(`/t/${FIX.thread.image}`);
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

  test("已删除的主题与不存在的主题 → 404", async ({ page }) => {
    for (const tid of [FIX.thread.deletedState, 959999]) {
      const res = await page.goto(`/t/${tid}`);
      expect(res?.status(), `tid ${tid}`).toBe(404);
    }
  });

  test("原作者账号已不存在 → 显示「已注销」，没有指向个人页的链接", async ({ page }) => {
    await page.goto(`/t/${FIX.thread.deletedAuthor}`);
    await expect(page.getByText("已注销").first()).toBeVisible();
    await expect(page.locator("header").getByRole("link", { name: "已注销" })).toHaveCount(0);
    // 占位账号不开个人页
    const res = await page.goto(`/u/${FIX.placeholderUserId}`);
    expect(res?.status()).toBe(404);
  });

  test("投票帖徽标", async ({ page }) => {
    await page.goto(`/t/${FIX.thread.poll}`);
    // 标题里也有“投票帖”三个字，徽标要精确匹配
    await expect(page.getByText("投票帖", { exact: true })).toBeVisible();
  });

  test("版块分页：水区 60 个非置顶主题 → 3 页，page=2 可达，越界页码被夹到最后一页", async ({
    page,
  }) => {
    const last = Math.ceil(FIX.water.total / FIX.water.perPage);
    await page.goto(`/f/${FIX.water.id}`);
    await expect(
      page.getByText(new RegExp(`共 ${FIX.water.total} 个主题 · 第 1/${last} 页`)),
    ).toBeVisible();
    await page.goto(`/f/${FIX.water.id}?page=2`);
    await expect(page.getByText(new RegExp(`第 2/${last} 页`))).toBeVisible();
    await page.goto(`/f/${FIX.water.id}?page=999`);
    await expect(page.getByText(new RegExp(`第 ${last}/${last} 页`))).toBeVisible();
  });

  test("畸形页码不会让游客触发 500：小数取整、非数字回第 1 页（审查 P2-1）", async ({ page }) => {
    const last = Math.ceil(FIX.water.total / FIX.water.perPage);
    for (const [raw, expected] of [
      ["2.5", 2],
      ["1e3", last],
      ["abc", 1],
      ["-4", 1],
    ] as const) {
      const res = await page.goto(`/f/${FIX.water.id}?page=${raw}`);
      expect(res?.status(), `page=${raw}`).toBe(200);
      await expect(page.getByText(new RegExp(`第 ${expected}/${last} 页`))).toBeVisible();
    }
  });

  test("置顶块：只在第 1 页，全站置顶 3 个（跨版块）+ 本版块置顶，不重复进入普通列表", async ({
    page,
  }) => {
    await page.goto(`/f/${FIX.water.id}`);
    const pinned = page.getByRole("region", { name: "置顶主题" });
    await expect(pinned).toBeVisible();
    // 3 个全站置顶都放在别的版块（anime），水区里能看到它们就证明跨版块置顶生效
    await expect(pinned.getByText("全站置顶", { exact: true })).toHaveCount(FIX.water.globalPins);
    await expect(pinned.locator(`a[href="/t/${FIX.thread.waterPin}"]`)).toHaveCount(1);
    const firstPinnedTitle = await pinned.locator('a[href^="/t/"]').first().innerText();

    await page.goto(`/f/${FIX.water.id}?page=2`);
    await expect(page.getByRole("region", { name: "置顶主题" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: firstPinnedTitle, exact: true })).toHaveCount(0);
  });

  test("主题分类筛选", async ({ page }) => {
    await page.goto(`/f/${FIX.anime.id}`);
    await page.getByRole("link", { name: FIX.anime.prefixName, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`type=${FIX.anime.prefixId}`));
    // 筛选结果里有且只有带该前缀的表情帖
    await expect(page.locator(`a[href="/t/${FIX.thread.emoji}"]`)).toHaveCount(1);
    await expect(page.locator(`a[href="/t/${FIX.thread.poll}"]`)).toHaveCount(0);
  });

  test("移动视口 375px smoke", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto(`/t/${FIX.thread.emoji}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
