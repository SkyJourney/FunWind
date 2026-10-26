import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { fillBody } from "./support/editor";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";

/**
 * 投票 E2E（M10）：发帖勾选投票 → 投票块出现 → 投票 → 结果可见 → 改票；
 * 重复提交幂等；截止后不可投；旧投票夹具（950004 单选两选项）渲染。
 */

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec(
      "DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE thread_id >= 990000)",
    );
    await q.exec(
      "DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE thread_id >= 990000)",
    );
    await q.exec("DELETE FROM polls WHERE thread_id >= 990000");
    await q.exec(
      "DELETE FROM posts WHERE thread_id IN (SELECT id FROM threads WHERE kind = 'poll' AND id >= 990000)",
    );
    await q.exec("DELETE FROM threads WHERE kind = 'poll' AND id >= 990000");
  });
});

test("发帖勾选投票 → 投票块渲染 → 投票 → 结果可见 → 改票", async ({ page, context }) => {
  const restore = await relaxPostInterval();
  try {
    await loginAs(context, USERS.member);
    await page.goto("/f/954/new");
    const title = `E2E 投票 ${Date.now()}`;
    await page.locator("#thread-title").fill(title);
    await fillBody(page, "投票帖正文");
    // 勾选「发起投票」→ 展开字段
    await page.locator("#poll-enabled").check();
    await page.locator('textarea[name="pollOptions"]').fill("选项甲\n选项乙");
    await page.locator('input[name="pollOptionLimit"]').fill("1");
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);

    // 投票块出现
    const poll = page.locator("#poll");
    await expect(poll).toBeVisible();
    await expect(poll.getByText("选项甲")).toBeVisible();

    // 投票（单选）
    await poll.getByLabel("选项甲").check();
    await poll.getByRole("button", { name: "投票" }).click();
    await expect(page).toHaveURL(/#poll$/);
    // 投票后显示计数
    await expect(poll.getByText(/共 1 人投票/)).toBeVisible();

    // 改票
    await poll.getByLabel("选项乙").check();
    await poll.getByRole("button", { name: "改票" }).click();
    await expect(poll.getByText(/选项乙/).first()).toBeVisible();
  } finally {
    await restore();
  }
});

test("重复提交同一票幂等（计数不翻倍）", async ({ page, context }) => {
  const restore = await relaxPostInterval();
  try {
    await loginAs(context, USERS.member);
    await page.goto("/f/954/new");
    await page.locator("#thread-title").fill(`E2E 投票幂等 ${Date.now()}`);
    await fillBody(page, "幂等测试");
    await page.locator("#poll-enabled").check();
    await page.locator('textarea[name="pollOptions"]').fill("甲\n乙");
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);
    const poll = page.locator("#poll");
    await poll.getByLabel("甲").check();
    await poll.getByRole("button", { name: "投票" }).click();
    await expect(poll.getByText(/共 1 人投票/)).toBeVisible();
    // 再投同一项
    await poll.getByLabel("甲").check();
    await poll.getByRole("button", { name: "改票" }).click();
    await expect(poll.getByText(/共 1 人投票/)).toBeVisible();
  } finally {
    await restore();
  }
});

test("旧投票夹具（950004 单选）渲染：选项可见但无结果（未投）", async ({ page }) => {
  await page.goto("/t/950004");
  const poll = page.locator("#poll");
  await expect(poll).toBeVisible();
  await expect(poll.getByText("选项一")).toBeVisible();
  // 游客：按钮不可用（登录后可投）
  await expect(poll.getByText(/登录后可参与投票/)).toBeVisible();
});

test("截止后不可投（closed 标记 + 无投票按钮）", async ({ page, context }) => {
  // 用库里的一条旧投票改截止时间（已过期）验证判定
  await withE2eDb(async (q) => {
    await q.exec("UPDATE polls SET ends_at = '2020-01-01 00:00:00' WHERE thread_id = 950004");
  });
  try {
    await loginAs(context, USERS.member);
    await page.goto("/t/950004");
    const poll = page.locator("#poll");
    await expect(poll.getByText("已截止")).toBeVisible();
    await expect(poll.getByRole("button", { name: "投票" })).toHaveCount(0);
  } finally {
    await withE2eDb(async (q) => {
      await q.exec("UPDATE polls SET ends_at = NULL WHERE thread_id = 950004");
    });
  }
});
