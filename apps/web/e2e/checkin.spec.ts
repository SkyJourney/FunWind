import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * 签到模块 E2E（M7）：首页签到条 → 签到 → 状态翻转 + 随机奖励入账；
 * 迁移历史驱动连签（直插昨日签到行）；模块停用后签到条消失（装卸）。
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

const yesterday = () => {
  const t = Date.now() - 86_400_000;
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10); // 北京日历日
};

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM checkins WHERE user_id = ?", [USERS.member]);
    await q.exec("DELETE FROM point_ledger WHERE user_id = ? AND channel = 'earn.checkin'", [
      USERS.member,
    ]);
    await q.exec(
      "UPDATE point_accounts SET balance = 100, lifetime_earned = 100, lifetime_spent = 0 WHERE user_id = ?",
      [USERS.member],
    );
  });
});

test("未登录：签到条只给登录引导（不显示任何他人活动）", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("登录后签到")).toBeVisible();
  await expect(page.getByRole("button", { name: "签到" })).toHaveCount(0);
});

test("签到 → 状态翻转、连签 1 天、随机奖励 1–5 入账、台账有签到奖励", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  const before = await balanceOf(page, USERS.member);

  await page.goto("/");
  await expect(page.getByText(/今日未签到/)).toBeVisible();
  await page.getByRole("button", { name: "签到" }).click();
  await expect(page.getByText(/今日已签到 ✓ 已连签 1 天/)).toBeVisible();
  await expect(page.getByRole("button", { name: "签到" })).toHaveCount(0);

  // 奖励在 1–5 之间（旧站 punch.reward 语义）
  const after = await balanceOf(page, USERS.member);
  expect(after - before).toBeGreaterThanOrEqual(1);
  expect(after - before).toBeLessThanOrEqual(5);

  await page.goto("/points");
  await expect(page.getByText("签到奖励").first()).toBeVisible();
});

test("迁移历史驱动连签：昨日已签 → 今日签到连签 2 天", async ({ page, context }) => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM checkins WHERE user_id = ?", [USERS.team]);
    // 签到行清了，台账也要清（随机奖励下幂等键金额才不会与历史冲突）+ 余额回夹具值
    await q.exec("DELETE FROM point_ledger WHERE user_id = ? AND channel = 'earn.checkin'", [
      USERS.team,
    ]);
    await q.exec(
      "UPDATE point_accounts SET balance = 50, lifetime_earned = 50, lifetime_spent = 0 WHERE user_id = ?",
      [USERS.team],
    );
    await q.exec(
      "INSERT INTO checkins (user_id, checkin_date, reward) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE reward = 0",
      [USERS.team, yesterday()],
    );
  });
  await loginAs(context, USERS.team);
  await page.goto("/");
  await expect(page.getByText(/今日未签到 · 已连签 1 天/)).toBeVisible(); // 未签时连签到昨天
  await page.getByRole("button", { name: "签到" }).click();
  await expect(page.getByText(/今日已签到 ✓ 已连签 2 天/)).toBeVisible();
});

test("模块停用：签到条消失，主体不受影响；恢复启用后回来", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  await withE2eDb(async (q) => {
    await q.exec(
      "INSERT INTO module_state (module_id, enabled, updated_at) VALUES ('checkin', 0, NOW()) ON DUPLICATE KEY UPDATE enabled = 0",
    );
  });
  await page.goto("/");
  await expect(page.getByText(/每日签到|今日未签到|今日已签到/)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); // 首页主体不受损

  await withE2eDb(async (q) => {
    await q.exec("UPDATE module_state SET enabled = 1 WHERE module_id = 'checkin'");
  });
  await page.goto("/");
  // member 在前一个用例已签到（连签 1 天）；恢复启用后签到条按 member 的状态渲染
  await expect(page.getByText(/今日已签到 ✓ 已连签 1 天/)).toBeVisible();
});
