import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS } from "./support/session";

/**
 * 双轨密码 E2E（M10.6c，docs/PASSWORD-DUAL-TRACK.md）：旧密码登录 → middleware 强制换密 →
 * 设新密 → 旧密码失效、新密码直登、其他页面恢复可达。
 * 认领/重置自动登录用例在 auth.spec（demo_alice / 注册用户，避免抢同一账号的认领冷却）。
 */

const LEGACY_PASSWORD = "e2e-legacy-pass";
const NEW_PASSWORD = "brand-new-pass-1";
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

/** 夹具自愈：把双轨账号恢复为「旧哈希待换密」形态——用例消费凭据后重跑仍可过 */
async function resetLegacyFixture(): Promise<void> {
  const stored = `md5$${md5(md5(LEGACY_PASSWORD) + "E2e9Xx")}$E2e9Xx`;
  await withE2eDb((q) =>
    q.exec(
      "UPDATE users SET password_hash = NULL, legacy_password_hash = ?, legacy_password_pending = 1 WHERE id = ?",
      [stored, USERS.legacyUser],
    ),
  );
}

async function uiLogin(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名或邮箱").fill(identifier);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
}

test("双轨：旧密码登录 → 强制换密 → 旧密码失效 → 新密码直登", async ({ page }) => {
  await resetLegacyFixture();
  await uiLogin(page, "e2e_legacy_user", LEGACY_PASSWORD);

  // middleware 快速门：除换密页外一律重定向
  await page.waitForURL("**/settings/password?force=1");
  await expect(page.getByText(/旧论坛密码/)).toBeVisible();

  // 其他页面确实被拦（cookie 门生效）
  await page.goto("/boards");
  await page.waitForURL("**/settings/password?force=1");

  await page.getByLabel("新密码（至少 8 位）", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("确认新密码").fill(NEW_PASSWORD);
  const resp = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined,
  );
  await page.getByRole("button", { name: "设置新密码" }).click();
  await resp;
  await page.waitForURL("**/settings/password?saved=1");
  await expect(page.getByText("新密码已生效")).toBeVisible();

  // 门已解除
  await page.goto("/boards");
  await expect(page).toHaveURL(/\/boards$/);

  // 退出后：旧密码失效，新密码直登且不再强制换密
  await page.getByRole("button", { name: "e2e_legacy_user" }).click();
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();

  await uiLogin(page, "e2e_legacy_user", LEGACY_PASSWORD);
  await expect(page.getByText("用户名或密码错误")).toBeVisible();

  await uiLogin(page, "e2e_legacy_user", NEW_PASSWORD);
  await expect(page.getByRole("button", { name: "e2e_legacy_user" })).toBeVisible();
  await expect(page).not.toHaveURL(/force=1/);
});
