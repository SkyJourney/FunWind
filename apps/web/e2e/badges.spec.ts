import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * 徽章模块 E2E（M7）：后台授予 → 资料页徽章卡（profile.header）→ 帖子页作者行图标位
 * （thread.user-badge）→ 重复授予拒绝 → 模块停用展示位消失（装卸）。
 * 夹具：主题 900004 的作者是 alice（90001）；种子徽章 demo-pioneer 已在 alice 名下（先清掉保证授予路径）。
 */

test.describe.configure({ mode: "serial" });

const THREAD = 900004;

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM user_badges WHERE user_id = ?", [USERS.alice]);
    await q.exec("DELETE FROM audit_log WHERE action = 'badge.grant' AND target_id = ?", [
      USERS.alice,
    ]);
    await q.exec("DELETE FROM event_outbox WHERE event_name = 'badge.awarded'");
    await q.exec("DELETE FROM event_log WHERE event_name = 'badge.awarded'");
    await q.exec("UPDATE module_state SET enabled = 1 WHERE module_id = 'badges'");
  });
});

const expectProfileBadge = async (page: Page, visible: boolean) => {
  await page.goto(`/u/${USERS.alice}`);
  const card = page.getByText(/荣誉徽章（\d+）/);
  if (visible) await expect(card).toBeVisible();
  else await expect(card).toHaveCount(0);
};

test("后台授予 → 资料页徽章卡 → 帖子页作者行图标", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  await page.goto("/admin/badges");
  await page.getByLabel("用户名").fill("demo_alice");
  await page.getByLabel("徽章").selectOption({ label: "[荣誉] 演示·开荒先锋" });
  await page.getByRole("button", { name: "授予" }).click();
  // M9.5：授予加了二次确认
  await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
  await expect(page).toHaveURL(/\/admin\/badges\?granted=1/);
  await expect(page.getByText("已授予")).toBeVisible();

  // 资料页：profile.header 徽章卡
  await expectProfileBadge(page, true);

  // 帖子页：首帖作者行的徽章图标位
  await page.goto(`/t/${THREAD}`);
  await expect(page.locator('[data-slot-content="thread-user-badges"]').first()).toBeVisible();

  // 审计与事件留痕
  await withE2eDb(async (q) => {
    const audits = await q.query<{ id: number }>(
      "SELECT id FROM audit_log WHERE action = 'badge.grant' AND target_id = ?",
      [USERS.alice],
    );
    expect(audits).toHaveLength(1);
    const logs = await q.query<{ id: number }>(
      "SELECT id FROM event_log WHERE event_name = 'badge.awarded' AND source = 'badges'",
    );
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

test("重复授予：带可读错误跳回", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  await page.goto("/admin/badges");
  await page.getByLabel("用户名").fill("demo_alice");
  await page.getByLabel("徽章").selectOption({ label: "[荣誉] 演示·开荒先锋" });
  await page.getByRole("button", { name: "授予" }).click();
  await expect(page).toHaveURL(/\/admin\/badges\?error=/);
  await expect(page.getByText("该用户已持有此徽章")).toBeVisible();
});

test("模块停用：两个展示位消失（作者行与资料页），恢复后回来", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  // 自包含：直接给 alice 造一条持有（授予路径已在用例 1 验证）
  await withE2eDb(async (q) => {
    await q.exec(
      "INSERT INTO user_badges (user_id, badge_id, awarded_at) SELECT ?, id, NOW() FROM badges WHERE `key` = 'demo-pioneer' ON DUPLICATE KEY UPDATE awarded_at = awarded_at",
      [USERS.alice],
    );
    // 显式建行切换（upsert），避免「无行=默认启用」的歧义
    await q.exec(
      "INSERT INTO module_state (module_id, enabled, updated_at) VALUES ('badges', 0, NOW()) ON DUPLICATE KEY UPDATE enabled = 0",
    );
    const st = await q.query<{ module_id: string; enabled: number }>(
      "SELECT module_id, enabled FROM module_state WHERE module_id = 'badges'",
    );
    console.log("[toggle] disabled state:", JSON.stringify(st));
  });
  await page.goto(`/t/${THREAD}`);
  await expect(page.locator('[data-slot-content="thread-user-badges"]')).toHaveCount(0);
  await expectProfileBadge(page, false);

  await withE2eDb(async (q) => {
    await q.exec("UPDATE module_state SET enabled = 1 WHERE module_id = 'badges'");
    const st = await q.query<{ module_id: string; enabled: number }>(
      "SELECT module_id, enabled FROM module_state WHERE module_id = 'badges'",
    );
    console.log("[toggle] enabled state:", JSON.stringify(st));
  });
  await expectProfileBadge(page, true);
});
