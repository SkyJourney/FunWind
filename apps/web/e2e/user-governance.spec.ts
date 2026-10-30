import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

const MEMBER_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$4ZRjLqgcJ4kA41dJfLLHUQ$lPZYIsJMv5I94ZOYGWcXvL+QNEKXcwx7Sz6bcAitpZU";
const MEMBER_PASSWORD = "e2e-admin-pass";
const MAIL_API = "http://127.0.0.1:8025/api/v1";
const BASE_URL = "http://127.0.0.1:3201";

async function prepareMember() {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM account_deletion_tokens WHERE user_id = ?", [USERS.member]);
    await q.exec("DELETE FROM account_deletion_requests WHERE user_id = ?", [USERS.member]);
    await q.exec("DELETE FROM sessions WHERE user_id = ?", [USERS.member]);
    await q.exec(
      "UPDATE users SET state = 'active', password_hash = ?, legacy_password_hash = NULL, legacy_password_pending = 0 WHERE id = ?",
      [MEMBER_HASH, USERS.member],
    );
  });
}

async function cleanupMember() {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM account_deletion_tokens WHERE user_id = ?", [USERS.member]);
    await q.exec("DELETE FROM account_deletion_requests WHERE user_id = ?", [USERS.member]);
    await q.exec("DELETE FROM sessions WHERE user_id = ?", [USERS.member]);
    await q.exec(
      "DELETE FROM notifications WHERE user_id = ? AND type IN ('account.deletion_requested', 'account.deletion_cancelled')",
      [USERS.member],
    );
  });
}

async function latestMailLink(email: string, subjectPart: string, since: number): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${MAIL_API}/messages?limit=30`);
    const data = (await response.json()) as {
      messages: { ID: string; Created: string; To: { Address: string }[]; Subject: string }[];
    };
    const mail = (data.messages ?? []).find(
      (row) =>
        row.To.some((to) => to.Address === email) &&
        row.Subject.includes(subjectPart) &&
        Date.parse(row.Created) >= since,
    );
    if (mail) {
      const full = (await (await fetch(`${MAIL_API}/message/${mail.ID}`)).json()) as {
        HTML: string;
      };
      const href = full.HTML.match(/href="(http[^"]+)"/)?.[1];
      if (!href) throw new Error("邮件中未找到安全操作链接");
      const link = new URL(href);
      return `${link.pathname}${link.search}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Mailpit 未收到预期邮件: ${subjectPart}`);
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  await prepareMember();
});

test.afterEach(async () => {
  await cleanupMember();
});

test("注销申请撤销后生成新会话，两个旧设备都不能复活", async ({ browser }) => {
  const firstContext = await browser.newContext({ baseURL: BASE_URL });
  const secondContext = await browser.newContext({ baseURL: BASE_URL });
  try {
    const oldFirst = await loginAs(firstContext, USERS.member);
    const oldSecond = await loginAs(secondContext, USERS.member);
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();

    await firstPage.goto("/settings/delete-account");
    await expect(firstPage.getByRole("heading", { name: "申请注销账号" })).toBeVisible();
    await firstPage.getByLabel("当前密码").fill(MEMBER_PASSWORD);
    await firstPage.getByRole("button", { name: "确认申请注销" }).click();
    await expect(firstPage).toHaveURL(/\/closure$/);
    await expect(firstPage.getByText(/30 天冷静期/)).toBeVisible();

    await withE2eDb(async (q) => {
      const sessions = await q.query<{ id: string }>("SELECT id FROM sessions WHERE user_id = ?", [
        USERS.member,
      ]);
      expect(sessions).toHaveLength(0);
      const requests = await q.query<{ status: string; verification_method: string }>(
        "SELECT status, verification_method FROM account_deletion_requests WHERE user_id = ? AND status = 'pending'",
        [USERS.member],
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ status: "pending", verification_method: "password" });
    });

    await secondPage.goto("/settings");
    await expect(secondPage).toHaveURL(/\/login$/);

    await firstPage.getByRole("button", { name: "撤销注销申请" }).click();
    const dialog = firstPage.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "确认" }).click();
    await expect(firstPage).toHaveURL(/\/settings\?account-deletion=cancelled$/);
    await expect(firstPage.getByRole("heading", { name: "设置" })).toBeVisible();

    const newCookie = (await firstContext.cookies()).find((cookie) => cookie.name === "fw_session");
    expect(newCookie?.value).toBeTruthy();
    expect(newCookie?.value).not.toBe(oldFirst);
    expect(newCookie?.value).not.toBe(oldSecond);
    const oldHashes = [oldFirst, oldSecond].map((token) =>
      createHash("sha256").update(token).digest("hex"),
    );
    await withE2eDb(async (q) => {
      const rows = await q.query<{ id: string }>("SELECT id FROM sessions WHERE user_id = ?", [
        USERS.member,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(createHash("sha256").update(newCookie!.value).digest("hex"));
      expect(oldHashes).not.toContain(rows[0]?.id);
    });

    await secondPage.goto("/settings");
    await expect(secondPage).toHaveURL(/\/login$/);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test("平板视口的注销设置布局不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await loginAs(page.context(), USERS.member);
  await page.goto("/settings/delete-account");
  await expect(page.getByRole("heading", { name: "申请注销账号" })).toBeVisible();
  const dimensions = await page.locator("body").evaluate((body) => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyWidth: body.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("全站封禁立即踢出已有设备，解封后旧 cookie 仍需重新登录，公众不见理由", async ({
  browser,
}) => {
  const adminContext = await browser.newContext({ baseURL: BASE_URL });
  const memberContext = await browser.newContext({ baseURL: BASE_URL });
  const guestContext = await browser.newContext({ baseURL: BASE_URL });
  const reason = `E2E 私密封禁理由 ${Date.now()}`;
  try {
    await loginAs(adminContext, USERS.admin);
    const oldSession = await loginAs(memberContext, USERS.member);
    const adminPage = await adminContext.newPage();
    const memberPage = await memberContext.newPage();
    const guestPage = await guestContext.newPage();

    await memberPage.goto("/settings");
    await expect(memberPage.getByRole("heading", { name: "设置" })).toBeVisible();
    await adminPage.goto(`/admin/users/${USERS.member}`);
    await adminPage.getByLabel("限制类型").selectOption("ban");
    await adminPage.getByPlaceholder("理由（必填，写入审计与通知）").fill(reason);
    await adminPage.getByRole("button", { name: "施加限制" }).click();
    const createDialog = adminPage.getByRole("dialog");
    await expect(createDialog).toBeVisible();
    await createDialog.getByRole("button", { name: "确认" }).click();
    await expect(adminPage.getByText("限制已生效")).toBeVisible();
    await expect(adminPage.getByText(reason)).toBeVisible();

    await memberPage.goto("/settings");
    await expect(memberPage).toHaveURL(/\/login$/);
    const oldSessionHash = createHash("sha256").update(oldSession).digest("hex");
    await withE2eDb(async (q) => {
      const rows = await q.query<{ id: string }>("SELECT id FROM sessions WHERE user_id = ?", [
        USERS.member,
      ]);
      expect(rows.some((row) => row.id === oldSessionHash)).toBe(false);
    });
    await guestPage.goto(`/u/${USERS.member}`);
    await expect(guestPage.getByText("已封禁", { exact: true })).toBeVisible();
    await expect(guestPage.getByText(reason)).toHaveCount(0);

    const liftNote = adminPage.getByPlaceholder("解除说明（必填）");
    await liftNote.fill("E2E 清理封禁");
    await adminPage.getByRole("button", { name: "解除" }).click();
    const liftDialog = adminPage.getByRole("dialog");
    await expect(liftDialog).toBeVisible();
    await liftDialog.getByRole("button", { name: "确认" }).click();
    await expect(adminPage.getByText("限制已解除")).toBeVisible();

    await memberPage.goto("/settings");
    await expect(memberPage).toHaveURL(/\/login$/);
    await memberPage.getByLabel("用户名或邮箱").fill("demo_member");
    await memberPage.getByLabel("密码", { exact: true }).fill(MEMBER_PASSWORD);
    await memberPage.getByRole("button", { name: "登录" }).click();
    await expect(memberPage.getByRole("button", { name: "demo_member" })).toBeVisible();
    const newSession = (await memberContext.cookies()).find(
      (cookie) => cookie.name === "fw_session",
    );
    expect(newSession?.value).toBeTruthy();
    expect(newSession?.value).not.toBe(oldSession);
    const newSessionHash = createHash("sha256").update(newSession!.value).digest("hex");
    await withE2eDb(async (q) => {
      const rows = await q.query<{ id: string }>("SELECT id FROM sessions WHERE user_id = ?", [
        USERS.member,
      ]);
      expect(rows.some((row) => row.id === newSessionHash)).toBe(true);
      expect(rows.some((row) => row.id === oldSessionHash)).toBe(false);
    });
  } finally {
    await withE2eDb((q) =>
      q.exec("DELETE FROM user_restrictions WHERE user_id = ? AND reason = ?", [
        USERS.member,
        reason,
      ]),
    );
    await adminContext.close();
    await memberContext.close();
    await guestContext.close();
  }
});

test("已封禁用户可通过密码提交申诉，管理员能查看并登记人工结果", async ({ browser, page }) => {
  const adminContext = await browser.newContext({ baseURL: BASE_URL });
  try {
    await page.goto("/appeal");
    await page.getByLabel("用户名或邮箱").fill("demo_banned");
    await page.getByLabel("当前密码").fill("e2e-banned-pass");
    await page.getByLabel("申诉理由").fill("E2E 申诉理由：请求人工复核当前封禁。");
    await page.getByRole("button", { name: "提交人工复核" }).click();
    await expect(
      page.getByText("已登记申诉；处理结果会通过站内通知或绑定邮箱告知。"),
    ).toBeVisible();

    await loginAs(adminContext, USERS.admin);
    const adminPage = await adminContext.newPage();
    await adminPage.goto("/admin/appeals");
    await expect(adminPage.getByRole("heading", { name: "申诉复核" })).toBeVisible();
    await expect(adminPage.getByText("E2E 申诉理由：请求人工复核当前封禁。")).toBeVisible();
    await adminPage.getByLabel("申诉处理决定").selectOption("approved");
    await adminPage.getByPlaceholder("处理结果（必填）").fill("E2E 人工复核已通过。");
    await adminPage.getByRole("button", { name: "保存结果" }).click();
    await expect(adminPage).toHaveURL(
      new RegExp(`/admin/users/${USERS.banned}\\?appeal=resolved$`),
    );
    await expect(adminPage.getByText("处理结果：E2E 人工复核已通过。")).toBeVisible();
  } finally {
    await withE2eDb(async (q) => {
      await q.exec("DELETE FROM user_appeals WHERE user_id = ?", [USERS.banned]);
      await q.exec("DELETE FROM notifications WHERE user_id = ? AND type LIKE 'account.appeal_%'", [
        USERS.banned,
      ]);
    });
    await adminContext.close();
  }
});

test("邮箱无密码账号可以在页面中确认注销并撤销", async ({ browser }) => {
  test.setTimeout(90_000);
  let original:
    | {
        email: string | null;
        email_key: string | null;
        email_verified_at: string | null;
        password_hash: string | null;
        legacy_password_hash: string | null;
        legacy_password_pending: number;
        state: string;
      }
    | undefined;
  const context = await browser.newContext({ baseURL: BASE_URL });
  const secondContext = await browser.newContext({ baseURL: BASE_URL });
  const since = Date.now() - 1000;
  try {
    await withE2eDb(async (q) => {
      const rows = await q.query<{
        email: string | null;
        email_key: string | null;
        email_verified_at: string | null;
        password_hash: string | null;
        legacy_password_hash: string | null;
        legacy_password_pending: number;
        state: string;
      }>(
        "SELECT email, email_key, email_verified_at, password_hash, legacy_password_hash, legacy_password_pending, state FROM users WHERE id = ?",
        [USERS.alice],
      );
      original = rows[0];
      await q.exec(
        "UPDATE users SET password_hash = NULL, legacy_password_hash = NULL, legacy_password_pending = 0, email = ?, email_key = ?, email_verified_at = NOW(), state = 'active' WHERE id = ?",
        ["alice@demo.local", "alice@demo.local", USERS.alice],
      );
      await q.exec("DELETE FROM account_deletion_tokens WHERE user_id = ?", [USERS.alice]);
      await q.exec("DELETE FROM account_deletion_requests WHERE user_id = ?", [USERS.alice]);
      await q.exec("DELETE FROM sessions WHERE user_id = ?", [USERS.alice]);
    });
    await loginAs(context, USERS.alice);
    await loginAs(secondContext, USERS.alice);
    const firstPage = await context.newPage();
    const secondPage = await secondContext.newPage();
    await firstPage.goto("/settings/delete-account");
    await firstPage.getByRole("button", { name: "向已验证邮箱发送确认链接" }).click();
    await expect(firstPage.getByRole("status").filter({ hasText: "确认邮件已发送" })).toBeVisible();

    const link = await latestMailLink("alice@demo.local", "确认注销申请", since);
    await firstPage.goto(link);
    await expect(firstPage.getByRole("heading", { name: "确认账号安全操作" })).toBeVisible();
    await firstPage.getByRole("button", { name: "继续" }).click();
    await expect(firstPage).toHaveURL(/\/closure\?requested=1$/);
    await expect(firstPage.getByText(/30 天冷静期/)).toBeVisible();

    await secondPage.goto("/settings");
    await expect(secondPage).toHaveURL(/\/login$/);
    await firstPage.getByRole("button", { name: "撤销注销申请" }).click();
    const dialog = firstPage.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "确认" }).click();
    await expect(firstPage).toHaveURL(/\/settings\?account-deletion=cancelled$/);
    await expect(firstPage.getByRole("heading", { name: "设置" })).toBeVisible();
    await secondPage.goto("/settings");
    await expect(secondPage).toHaveURL(/\/login$/);
  } finally {
    await withE2eDb(async (q) => {
      await q.exec("DELETE FROM account_deletion_tokens WHERE user_id = ?", [USERS.alice]);
      await q.exec("DELETE FROM account_deletion_requests WHERE user_id = ?", [USERS.alice]);
      await q.exec("DELETE FROM sessions WHERE user_id = ?", [USERS.alice]);
      if (original) {
        await q.exec(
          "UPDATE users SET email = ?, email_key = ?, email_verified_at = ?, password_hash = ?, legacy_password_hash = ?, legacy_password_pending = ?, state = ? WHERE id = ?",
          [
            original.email,
            original.email_key,
            original.email_verified_at,
            original.password_hash,
            original.legacy_password_hash,
            original.legacy_password_pending,
            original.state,
            USERS.alice,
          ],
        );
      }
    });
    await context.close();
    await secondContext.close();
  }
});
