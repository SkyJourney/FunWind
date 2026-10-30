import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

const MEMBER_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$4ZRjLqgcJ4kA41dJfLLHUQ$lPZYIsJMv5I94ZOYGWcXvL+QNEKXcwx7Sz6bcAitpZU";

test("手机视口的注销说明与重新认证控件完整且无横向溢出", async ({ page }) => {
  await withE2eDb(async (q) => {
    await q.exec(
      "UPDATE users SET state = 'active', password_hash = ?, legacy_password_hash = NULL, legacy_password_pending = 0 WHERE id = ?",
      [MEMBER_HASH, USERS.member],
    );
    await q.exec("DELETE FROM account_deletion_requests WHERE user_id = ?", [USERS.member]);
    await q.exec("DELETE FROM sessions WHERE user_id = ?", [USERS.member]);
  });
  await loginAs(page.context(), USERS.member);
  await page.goto("/settings/delete-account");

  await expect(page.getByRole("heading", { name: "申请注销账号" })).toBeVisible();
  await expect(page.getByLabel("当前密码")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认申请注销" })).toBeVisible();
  const dimensions = await page.locator("body").evaluate((body) => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyWidth: body.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});
