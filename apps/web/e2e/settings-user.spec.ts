import { expect, test } from "@playwright/test";
import { USERS, loginAs } from "./support/session";

/**
 * 设置中心冒烟（M10.6c）：hub 可达、资料保存回显、通知偏好翻转、改密校验错误回显。
 * 改密全流程与强制换密由 dual-track-auth.spec 覆盖。
 */

test("设置中心：hub / 资料 / 通知偏好 / 邮箱校验", async ({ page }) => {
  await loginAs(page.context(), USERS.member);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.getByText("个人资料", { exact: true }).first()).toBeVisible();

  // 资料：保存→成功提示回显
  await page.goto("/settings/profile");
  await page.getByLabel(/简介/).fill("E2E 冒烟简介");
  const resp = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined,
  );
  await page.getByRole("button", { name: "保存资料" }).click();
  await resp;
  await expect(page.getByText("资料已保存")).toBeVisible();

  // 通知偏好：翻转首行按钮文案（已开启 → 已关闭）
  await page.goto("/settings/notifications");
  const firstToggle = page.getByRole("button", { name: /已开启/ }).first();
  await firstToggle.click();
  await expect(page.getByRole("button", { name: /已关闭/ }).first()).toBeVisible();

  // 邮箱：当前密码错误 → 服务端错误回显（不做真实换绑，避免污染夹具邮箱断言）
  await page.goto("/settings/email");
  await page.getByLabel("新邮箱").fill("member-new@test.local");
  await page.getByLabel("当前密码").fill("definitely-wrong");
  await page.getByRole("button", { name: "更换邮箱" }).click();
  await expect(page.getByText("当前密码不正确")).toBeVisible();
});
