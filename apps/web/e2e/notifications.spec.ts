import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";
import { relaxPostInterval } from "./support/limits";
import { fillBody } from "./support/editor";

/**
 * 通知中心 E2E（M8 S6）：真实回帖 → 楼主铃铛未读 → 面板内容 → 查看全部 → 标记已读 → 清零；
 * 公告合并进总数；游客无铃铛。
 */

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    // 复位：清空 team 与 alice 的互动类通知（公告保留——合并计数要用）
    await q.exec("DELETE FROM notifications WHERE user_id = ? AND category = 'interaction'", [
      USERS.alice,
    ]);
  });
});

test("游客无铃铛；登录后铃铛出现", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /通知/ })).toHaveCount(0);
  await loginAs(context, USERS.alice);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /通知/ })).toBeVisible();
});

test("真实回帖 → 楼主铃铛未读 +1，面板与页面都能看到", async ({ page, context, browser }) => {
  const restore = await relaxPostInterval();
  try {
    // alice 发主题
    const aliceCtx = context;
    await loginAs(aliceCtx, USERS.alice);
    await page.goto("/f/954/new");
    const title = `E2E 通知主题 ${Date.now()}`;
    await page.locator("#thread-title").fill(title);
    await fillBody(page, "通知测试正文");
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);
    const threadUrl = page.url();

    // team 回复
    const teamCtx = await browser.newContext();
    const teamPage = await teamCtx.newPage();
    await loginAs(teamCtx, USERS.team);
    await teamPage.goto(threadUrl);
    await fillBody(teamPage, "这是一条会产生通知的回复");
    await teamPage.getByRole("button", { name: "发表回复" }).click();
    await expect(teamPage).toHaveURL(/(\?page=\d+)?#p\d+$/);
    await teamCtx.close();

    // alice 的铃铛出现未读（含公告基数——断言 ≥1 而非精确值）
    await page.goto("/");
    await expect(page.getByTestId("bell-unread")).toBeVisible();
  } finally {
    await restore();
  }
});

test("查看全部 → 通知页：回帖通知在列，单条已读 → 未读减少；全部已读 → 清零", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.alice);
  await page.goto("/notifications");

  // 互动 Tab：回帖通知（模板：{actor} 回复了你的主题《…》）
  await page.getByRole("link", { name: /互动/ }).click();
  await expect(page.getByText(/回复了你的主题/).first()).toBeVisible();

  // 单条已读
  const unreadBefore = await page.getByText(/未读 \d+/).innerText();
  const readButtons = page.getByRole("button", { name: "已读", exact: true });
  if ((await readButtons.count()) > 0) {
    await readButtons.first().click();
    await expect(page.getByText(/未读 \d+/)).not.toHaveText(unreadBefore);
  }

  // 全部已读 → 未读 0（公告也写已读）
  await page.getByRole("button", { name: "全部已读" }).click();
  await expect(page.getByText("未读 0")).toBeVisible();
  await expect(page.getByRole("button", { name: "全部已读" })).toHaveCount(0);

  // 铃铛归零（徽标消失）
  await page.goto("/");
  await expect(page.getByTestId("bell-unread")).toHaveCount(0);
});

test("公告合并进总数：通知页公告 Tab 显示有效公告", async ({ page, context }) => {
  await loginAs(context, USERS.alice);
  await page.goto("/notifications?cat=announcement");
  await expect(page.getByText(/公告：/).first()).toBeVisible();
});
