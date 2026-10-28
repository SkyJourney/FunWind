import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { fillBody } from "./support/editor";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";

/**
 * 互动 E2E（M8，补齐文档承诺的三个闭环）：
 * 点赞→对方收到通知；关注版块→动态页出现新帖；打标签→标签页筛选命中。
 */

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    // 复位：alice 的互动通知与点赞/关注/标签残留
    await q.exec("DELETE FROM notifications WHERE user_id = ? AND category = 'interaction'", [
      USERS.alice,
    ]);
    await q.exec("DELETE FROM reactions WHERE user_id = ?", [USERS.team]);
    await q.exec(
      "UPDATE posts SET like_count = (SELECT COUNT(*) FROM reactions r WHERE r.post_id = posts.id AND r.kind = 'like') WHERE id = 900101",
    );
    await q.exec("DELETE FROM follows WHERE user_id = ? AND target_type = 'forum'", [USERS.team]);
    await q.exec("DELETE FROM thread_tags WHERE thread_id > 900000 AND thread_id < 960000");
    await q.exec("DELETE FROM tags WHERE name = 'E2E标签'");
  });
});

test("点赞 → 作者收到 post.liked 通知；再点取消", async ({ page, context, browser }) => {
  const restore = await relaxPostInterval();
  try {
    await loginAs(context, USERS.alice);
    await page.goto("/t/900001"); // alice 的欢迎主题（种子）
    await expect(page.locator('form[data-testid="like-900101"] button')).toBeVisible();

    // team 点赞首帖
    const teamCtx = await browser.newContext();
    const teamPage = await teamCtx.newPage();
    await loginAs(teamCtx, USERS.team);
    await teamPage.goto("/t/900001");
    await teamPage.locator('form[data-testid="like-900101"] button').click();
    // 计数出现（900101=首帖）。M10.7 起点赞是乐观更新：数字**立即**出现，不再代表服务端已处理完；
    // 必须等 Server Action 真正完成（按钮 aria-busy 回到 false）再往下，否则下面关闭上下文会把在途请求中止、点赞没落库
    const btn = teamPage.locator('form[data-testid="like-900101"] button');
    await expect(btn).toHaveText(/\s*1\s*/);
    await expect(btn).toHaveAttribute("aria-busy", "false", { timeout: 8000 });
    await teamCtx.close();

    // alice 的通知页出现「赞了你的帖子」
    await page.goto("/notifications?cat=interaction");
    await expect(page.getByText(/赞了你的帖子/).first()).toBeVisible();
  } finally {
    await restore();
  }
});

test("关注版块 → 该版块新帖出现在动态页", async ({ page, context }) => {
  const restore = await relaxPostInterval();
  try {
    // team 关注 954 并由 alice 发新帖
    await loginAs(context, USERS.alice);
    await withE2eDb(async (q) => {
      await q.exec(
        "INSERT INTO follows (user_id, target_type, target_id, created_at) VALUES (?, 'forum', ?, NOW()) ON DUPLICATE KEY UPDATE created_at = created_at",
        [USERS.team, FIX.compose.id],
      );
    });
    await page.goto(`/f/${FIX.compose.id}/new`);
    await page.locator("#thread-title").fill(`E2E 动态 ${Date.now()}`);
    await fillBody(page, "关注动态测试正文");
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);

    // team 的动态页出现这篇新帖
    const teamCtx = await context.browser()!.newContext();
    const teamPage = await teamCtx.newPage();
    await loginAs(teamCtx, USERS.team);
    await teamPage.goto("/follows");
    await expect(teamPage.getByText(/E2E 动态/).first()).toBeVisible();
    await teamCtx.close();
  } finally {
    await restore();
  }
});

test("发帖打标签 → 版块标签云与 ?tag= 筛选命中", async ({ page, context }) => {
  const restore = await relaxPostInterval();
  try {
    await loginAs(context, USERS.alice);
    await page.goto(`/f/${FIX.compose.id}/new`);
    await page.locator("#thread-title").fill(`E2E 标签筛选 ${Date.now()}`);
    await page.locator("#thread-tags").fill("E2E标签");
    await fillBody(page, "标签筛选测试正文");
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);
    const threadUrl = page.url();
    const tid = Number(threadUrl.match(/\/t\/(\d+)/)![1]);

    // 版块页标签云出现，点击后筛选命中该主题
    await page.goto(`/f/${FIX.compose.id}`);
    const tagChip = page.getByRole("link", { name: /E2E标签/ }).first();
    await expect(tagChip).toBeVisible();
    await tagChip.click();
    await expect(page).toHaveURL(/tag=E2E%E6%A0%87%E7%AD%BE/);
    await expect(page.getByRole("link", { name: /E2E 标签筛选/ }).first()).toBeVisible();

    // 帖子页标签 chips
    await page.goto(`/t/${tid}`);
    await expect(page.getByRole("link", { name: "#E2E标签" })).toBeVisible();
  } finally {
    await restore();
  }
});
