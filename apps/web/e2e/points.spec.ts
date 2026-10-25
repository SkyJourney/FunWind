import { expect, test, type Page } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { fillBody } from "./support/editor";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";
import { withE2eDb } from "./support/db";

/**
 * 积分模块 E2E（M7）：发帖 → 入账 → /points 台账；后台规则配置驱动奖励数值；
 * 管理员手工调整（强制备注）→ 余额变化 + audit_log 留痕。串行执行，beforeAll 复位状态。
 */

test.describe.configure({ mode: "serial" });

const balanceOf = async (page: Page, uid: number) => {
  await page.goto(`/u/${uid}`);
  const text = await page
    .getByText(/青翼币 \d+/)
    .first()
    .innerText();
  return Number(text.match(/青翼币 (\d+)/)![1]);
};

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    // 复位：member 的奖励/调整台账清空，余额回夹具值 100；奖励规则回默认（+3/+1，不限）
    await q.exec(
      "DELETE FROM point_ledger WHERE user_id = ? AND channel IN ('earn.post','earn.reply','adjust.admin','earn.checkin')",
      [USERS.member],
    );
    await q.exec(
      "UPDATE point_accounts SET balance = 100, lifetime_earned = 100, lifetime_spent = 0 WHERE user_id = ?",
      [USERS.member],
    );
    await q.exec(`UPDATE site_settings SET value = ? WHERE \`key\` = 'points.reward'`, [
      JSON.stringify({ post: 3, reply: 1, postDailyCap: 0, replyDailyCap: 0 }),
    ]);
  });
});

test("游客访问 /points → 跳转登录", async ({ page }) => {
  await page.goto("/points");
  await expect(page).toHaveURL(/\/login/);
});

test("发主题 → earn.post 入账 → /points 台账显示发帖奖励", async ({ page, context }) => {
  const restore = await relaxPostInterval();
  try {
    const before = await balanceOf(page, USERS.member);
    await loginAs(context, USERS.member);
    await page.goto(`/f/${FIX.compose.id}/new`);
    await page.locator("#thread-title").fill(`E2E 积分 ${Date.now()}`);
    await fillBody(page, "积分入账测试正文");
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);

    // 资料页的青翼币总数 +3
    await expect
      .poll(async () => balanceOf(page, USERS.member), { timeout: 10_000 })
      .toBe(before + 3);

    // /points：余额行与台账分录
    await page.goto("/points");
    await expect(page.getByText("当前余额")).toBeVisible();
    await expect(page.getByText("发帖奖励").first()).toBeVisible();
    await expect(page.getByText("+3").first()).toBeVisible();
  } finally {
    await restore();
  }
});

test("后台规则配置：发帖奖励改为 5 → 发帖入账 5", async ({ page, browser, context }) => {
  const restore = await relaxPostInterval();
  try {
    await loginAs(context, USERS.admin);
    await page.goto("/admin/points");
    await page.getByLabel("发帖奖励").fill("5");
    await page.getByRole("button", { name: "保存规则" }).click();
    await expect(page).toHaveURL(/\/admin\/points\?saved=1/);
    await expect(page.getByText("奖励规则已保存")).toBeVisible();

    // 用独立 context 以 member 发帖（奖励入 member 账户）
    const memberCtx = await browser.newContext();
    const memberPage = await memberCtx.newPage();
    await loginAs(memberCtx, USERS.member);
    const before = await balanceOf(page, USERS.member);
    await memberPage.goto(`/f/${FIX.compose.id}/new`);
    await memberPage.locator("#thread-title").fill(`E2E 积分改值 ${Date.now()}`);
    await fillBody(memberPage, "按新规则发放");
    await memberPage.getByRole("button", { name: "发布主题" }).click();
    await expect(memberPage).toHaveURL(/\/t\/\d+$/);
    await expect
      .poll(async () => balanceOf(page, USERS.member), { timeout: 10_000 })
      .toBe(before + 5);
    await memberCtx.close();
  } finally {
    await restore();
    // 恢复默认规则（无论用例走到哪一步）
    await withE2eDb(async (q) => {
      await q.exec(`UPDATE site_settings SET value = ? WHERE \`key\` = 'points.reward'`, [
        JSON.stringify({ post: 3, reply: 1, postDailyCap: 0, replyDailyCap: 0 }),
      ]);
    });
  }
});

test("管理员手工调整：强制备注、余额变化、audit_log 留痕", async ({ page, browser, context }) => {
  const before = await balanceOf(page, USERS.member);
  await loginAs(context, USERS.admin);
  await page.goto("/admin/points");

  // 备注必填：空备注被 zod 拦下（defineAction notFound 之外的表单校验——required 属性在浏览器侧先拦）
  await page.getByLabel("用户名").fill("demo_member");
  await page.getByLabel("额度（正加负减）").fill("7");
  await page.getByLabel("备注（必填，入台账与审计）").fill("E2E 活动补偿");
  await page.getByRole("button", { name: "执行调整" }).click();
  await expect(page).toHaveURL(/\/admin\/points\?adjusted=1/);
  await expect(page.getByText("调整已入账")).toBeVisible();

  await expect
    .poll(async () => balanceOf(page, USERS.member), { timeout: 10_000 })
    .toBe(before + 7);

  // 审计留痕
  await withE2eDb(async (q) => {
    const rows = await q.query<{ after_json: string }>(
      "SELECT after_json FROM audit_log WHERE action = 'points.adjust' AND target_id = ? ORDER BY id DESC LIMIT 1",
      [USERS.member],
    );
    expect(JSON.stringify(rows[0]?.after_json ?? "")).toContain("E2E 活动补偿");
  });

  // 台账里有「管理员调整」分录（member 自己的 /points；page 是 admin 会话，看得到的是 admin 的台账）
  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();
  await loginAs(memberCtx, USERS.member);
  await memberPage.goto("/points");
  await expect(memberPage.getByText("管理员调整").first()).toBeVisible();
  await expect(memberPage.getByText("E2E 活动补偿")).toBeVisible();
  await memberCtx.close();
});
