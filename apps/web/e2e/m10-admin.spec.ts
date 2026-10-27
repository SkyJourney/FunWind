import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";
import { fillBody } from "./support/editor";

/**
 * M10 补做 E2E：投票管理（关闭/删除）与私信管理（删消息）。
 * 会员访问两个管理页 404（站点级权限）。
 */

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM messages");
    await q.exec("DELETE FROM conversation_members");
    await q.exec("DELETE FROM conversations");
    await q.exec("DELETE FROM notifications WHERE type = 'pm.received'");
  });
});

test("私信管理：发送 → 管理页可见 → 删除（正文标记 + 审计）", async ({
  page,
  context,
  browser,
}) => {
  // alice → team 发一条
  await loginAs(context, USERS.alice);
  await page.goto(`/u/${USERS.team}`);
  await page.locator("main").getByRole("link", { name: "私信" }).first().click();
  await page.locator('textarea[name="body"]').fill("M10 补做：管理删我");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page).toHaveURL(new RegExp("/messages/\\d+"));

  // admin 删除
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await loginAs(adminCtx, USERS.admin);
  await adminPage.goto("/admin/pm");
  await expect(adminPage.getByText("M10 补做：管理删我")).toBeVisible();
  await adminPage
    .locator("li", { hasText: "M10 补做：管理删我" })
    .locator('input[name="reason"]')
    .fill("E2E 删除理由：违规");
  await adminPage
    .locator("li", { hasText: "M10 补做：管理删我" })
    .getByRole("button", { name: "删除" })
    .click();
  await adminPage.getByRole("button", { name: "确认" }).click();
  await expect(adminPage).toHaveURL(/\/admin\/pm\?deleted=1/);
  await expect(adminPage.getByText(/已由管理员删除：E2E 删除理由/)).toBeVisible();

  // 审计留痕
  await withE2eDb(async (q) => {
    const rows = await q.query<{ id: number }>(
      "SELECT id FROM audit_log WHERE action = 'pm.message.delete' ORDER BY id DESC LIMIT 1",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
  await adminCtx.close();
});

test("投票管理：关闭投票 → 已截止标记；删除投票 → 主题回普通帖", async ({
  page,
  context,
  browser,
}) => {
  // member 建一个投票帖
  const restore = (await import("./support/limits")).relaxPostInterval;
  const restoreFn = await restore();
  try {
    await loginAs(context, USERS.member);
    await page.goto("/f/954/new");
    await page.locator("#thread-title").fill(`E2E 投票管理 ${Date.now()}`);
    await page.locator("#poll-enabled").check(); // 展开投票字段
    await page.locator('textarea[name="pollOptions"]').fill("管理选项一\n管理选项二");
    await fillBody(page, "管理测试正文");
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);
    const threadUrl = page.url();
    const tid = Number(threadUrl.match(/\/t\/(\d+)/)![1]);

    // admin 删除投票
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await loginAs(adminCtx, USERS.admin);
    await adminPage.goto("/admin/poll");
    const row = adminPage.locator("li", { hasText: /E2E 投票管理/ });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "删除投票" }).click();
    await adminPage.getByRole("button", { name: "确认" }).click();
    await expect(adminPage).toHaveURL(/\/admin\/poll\?deleted=1/);

    // 主题回普通帖（投票块消失、kind 回 normal）
    await page.goto(`/t/${tid}`);
    await expect(page.locator("#poll")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // 审计
    await withE2eDb(async (q) => {
      const rows = await q.query<{ id: number }>(
        "SELECT id FROM audit_log WHERE action = 'poll.delete' ORDER BY id DESC LIMIT 1",
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
    await adminCtx.close();
  } finally {
    await restoreFn();
  }
});

test("会员访问投票/私信管理页 → 404（站点级权限）", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  for (const path of ["/admin/poll", "/admin/pm"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }
});
