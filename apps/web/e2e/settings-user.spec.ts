import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * 设置中心冒烟（M10.6c）：hub 可达、资料保存回显、通知偏好翻转、改密校验错误回显。
 * 改密全流程与强制换密由 dual-track-auth.spec 覆盖；S1 安全类邮件由本文件第二用例覆盖。
 */

/** 演示账号密码哈希（seed-data ADMIN_HASH 同值；自愈重置用） */
const MEMBER_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$4ZRjLqgcJ4kA41dJfLLHUQ$lPZYIsJMv5I94ZOYGWcXvL+QNEKXcwx7Sz6bcAitpZU";

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

  // 通知偏好：翻转首个开关（M10.7 起是真正的 Switch：role=switch + aria-checked；站内通知默认开启）
  await page.goto("/settings/notifications");
  const firstToggle = page.getByRole("switch", { name: /站内通知/ }).first();
  // 不假定初始状态（库里可能留着上一轮的结果）：读初始值，断言点击后翻转，再复位
  const initial = await firstToggle.getAttribute("aria-checked");
  await firstToggle.click();
  await expect(firstToggle).toHaveAttribute("aria-checked", initial === "true" ? "false" : "true");
  await expect(firstToggle).toBeEnabled({ timeout: 6000 });
  await firstToggle.click();
  await expect(firstToggle).toHaveAttribute("aria-checked", initial!);
  await expect(firstToggle).toBeEnabled({ timeout: 6000 });

  // 邮箱：当前密码错误 → 服务端错误回显（不做真实换绑，避免污染夹具邮箱断言）
  await page.goto("/settings/email");
  const changeEmailForm = page.locator("form").filter({ has: page.getByLabel("新邮箱") });
  await changeEmailForm.getByLabel("新邮箱").fill("member-new@example.com");
  await changeEmailForm.getByLabel("当前密码").fill("definitely-wrong");
  await changeEmailForm.getByRole("button", { name: "更换邮箱" }).click();
  await expect(page.getByText("当前密码不正确")).toBeVisible();
});

test("错误当前密码不会占用目标邮箱验证额度", async ({ browser }) => {
  const targetEmail = `e2e-rate-${Date.now()}@example.com`;
  for (const userId of [USERS.xiaoyi, USERS.team, USERS.alice, USERS.admin, USERS.member]) {
    const context = await browser.newContext();
    try {
      await loginAs(context, userId);
      const page = await context.newPage();
      await page.goto("/settings/email");
      const changeEmailForm = page.locator("form").filter({ has: page.getByLabel("新邮箱") });
      await changeEmailForm.getByLabel("新邮箱").fill(targetEmail);
      await changeEmailForm.getByLabel("当前密码").fill("definitely-wrong");
      await changeEmailForm.getByRole("button", { name: "更换邮箱" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
    } finally {
      await context.close();
    }
  }

  type EmailState = {
    email: string | null;
    email_key: string | null;
    email_verified_at: string | null;
    email_verification_required: number;
  };
  const [before] = await withE2eDb((q) =>
    q.query<EmailState>(
      "SELECT email, email_key, email_verified_at, email_verification_required FROM users WHERE id = ?",
      [USERS.member],
    ),
  );
  if (!before) throw new Error("E2E member fixture is missing");

  const context = await browser.newContext();
  try {
    await loginAs(context, USERS.member);
    const page = await context.newPage();
    await page.goto("/settings/email");
    const changeEmailForm = page.locator("form").filter({ has: page.getByLabel("新邮箱") });
    await changeEmailForm.getByLabel("新邮箱").fill(targetEmail);
    await changeEmailForm.getByLabel("当前密码").fill("e2e-admin-pass");
    await changeEmailForm.getByRole("button", { name: "更换邮箱" }).click();
    await page.waitForURL("**/settings/email?saved=1&verification=sent");
    await expect(page.getByText("验证链接已发送，请查收当前邮箱。")).toBeVisible();
  } finally {
    await withE2eDb(async (q) => {
      await q.exec("DELETE FROM email_tokens WHERE user_id = ?", [USERS.member]);
      await q.exec(
        "UPDATE users SET email = ?, email_key = ?, email_verified_at = ?, email_verification_required = ? WHERE id = ?",
        [
          before.email,
          before.email_key,
          before.email_verified_at,
          before.email_verification_required,
          USERS.member,
        ],
      );
    });
    await context.close();
  }
});

test("S1 安全类邮件：改密触发通知；后台关闭后停发", async ({ browser }) => {
  test.setTimeout(120_000);
  // 自愈：恢复 member 密码与安全开关（上轮消费过的中间态也能重跑）
  await withE2eDb((q) =>
    q.exec("UPDATE users SET password_hash = ? WHERE id = ?", [MEMBER_HASH, USERS.member]),
  );
  await withE2eDb((q) =>
    q.exec(
      "UPDATE site_settings SET value = JSON_SET(value, '$.enabled', true) WHERE `key` = 'email.security'",
    ),
  );
  const memberCtx = await browser.newContext();
  await loginAs(memberCtx, USERS.member);
  const member = await memberCtx.newPage();

  // 只统计本次改密动作之后到达的邮件（Mailpit 跨运行保留历史）
  let since = Date.now() - 1000;
  const countMail = async (): Promise<number> => {
    const list = (await (
      await member.request.get("http://127.0.0.1:8025/api/v1/messages")
    ).json()) as {
      messages: { To: { Address: string }[]; Subject: string; Created: string }[];
    };
    return list.messages.filter(
      (m) =>
        m.Subject.includes("密码已修改") &&
        m.To.some((t) => t.Address === "member@demo.local") &&
        Date.parse(m.Created) >= since,
    ).length;
  };
  const resetSince = () => {
    since = Date.now() - 1000;
  };

  // 后台先关闭安全类邮件 → 改密 → 无邮件
  const adminCtx = await browser.newContext();
  await loginAs(adminCtx, USERS.admin);
  const admin = await adminCtx.newPage();
  await admin.goto("/admin/settings");
  // 复选框无可达名——用表单内定位：安全组表单里的 checkbox
  const secBox = admin
    .locator("form", { has: admin.getByRole("button", { name: "保存安全通知开关" }) })
    .locator('input[name="enabled"]');
  await secBox.uncheck();
  const respOff = admin.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined,
  );
  await admin.getByRole("button", { name: "保存安全通知开关" }).click();
  await respOff;

  await member.goto("/settings/password");
  await member.getByLabel("当前密码").fill("e2e-admin-pass");
  await member.getByLabel("新密码（至少 8 位）", { exact: true }).fill("member-pass-4444");
  await member.getByLabel("确认新密码").fill("member-pass-4444");
  const respPw = member.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined,
  );
  await member.getByRole("button", { name: "设置新密码" }).click();
  await respPw;
  await member.waitForURL("**/settings/password?saved=1");
  await member.waitForTimeout(1500);
  resetSince(); // 只看此后是否出现（OFF 段期望 0：无新邮件可计）
  expect(await countMail()).toBe(0);

  // 后台重新开启 → 再改密（改回原密码）→ 收到「密码已修改」
  await admin.goto("/admin/settings");
  await secBox.check();
  const respOn = admin.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined,
  );
  await admin.getByRole("button", { name: "保存安全通知开关" }).click();
  await respOn;

  await member.goto("/settings/password");
  await member.getByLabel("当前密码").fill("member-pass-4444");
  await member.getByLabel("新密码（至少 8 位）", { exact: true }).fill("e2e-admin-pass");
  await member.getByLabel("确认新密码").fill("e2e-admin-pass");
  const respPw2 = member.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined,
  );
  await member.getByRole("button", { name: "设置新密码" }).click();
  await respPw2;
  await member.waitForURL("**/settings/password?saved=1");
  resetSince();
  await expect.poll(countMail, { timeout: 15_000 }).toBeGreaterThan(0);

  await adminCtx.close();
  await memberCtx.close();
});
