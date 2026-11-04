import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";

/**
 * M11.3 注册策略：四种开关组合下注册页与注册 Action 的行为。
 *
 * 策略是全站共享状态，直接写 register.policy 切换，并在 afterEach 删除该键复原为默认邀请制，
 * 避免影响依赖邀请注册的 auth.spec。注册页读策略走请求级缓存（无进程缓存），写库后下一次请求即生效。
 * 邀请码用 E2E 夹具 E2E-INVITE-CODE；每个用例注册成功的账号只在本文件里使用。
 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

const MAIL_API = "http://127.0.0.1:8025/api/v1";
const PASSWORD = "e2e-password-123";

type Policy = { open: boolean; invite: boolean; verifyEmail: boolean };

async function setPolicy(p: Policy) {
  await withE2eDb((q) =>
    q.exec(
      "INSERT INTO site_settings (`key`, value, updated_at) VALUES ('register.policy', CAST(? AS JSON), NOW()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()",
      [JSON.stringify(p)],
    ),
  );
}

async function fillAccount(page: Page, name: string) {
  await page.getByLabel("用户名").fill(name);
  await page.getByLabel("邮箱").fill(`${name}@test.local`);
  await page.getByLabel("密码（至少 8 位）").fill(PASSWORD);
}

const unique = (tag: string) => `e2e_${tag}_${Date.now() % 1_000_000}`;

test.afterEach(async () => {
  // 复原为默认（键不存在 = 旧 register.mode = invite），并把本文件造的邀请码占用还原
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM site_settings WHERE `key` = 'register.policy'");
    await q.exec(
      "UPDATE invite_codes SET used_by = NULL, used_at = NULL WHERE code = 'E2E-INVITE-CODE'",
    );
  });
});

test("仅邀请：邀请码必填；不填被拒且不占邀请码名额", async ({ page }) => {
  await setPolicy({ open: false, invite: true, verifyEmail: false });
  await page.goto("/register");
  await expect(page.getByLabel("邀请码", { exact: true })).toBeVisible();
  await expect(page.getByText("当前注册方式：邀请制。")).toBeVisible();
  // 浏览器 required 会拦住空提交，这里直接用 JS 去掉 required 验证服务端也拒绝
  await page.getByLabel("邀请码", { exact: true }).evaluate((el) => el.removeAttribute("required"));
  await fillAccount(page, unique("noinv"));
  await page.getByRole("button", { name: "凭邀请码注册" }).click();
  await expect(page.getByText("请输入邀请码")).toBeVisible();
});

test("仅开放（不要求验证）：无邀请码栏，注册即登录", async ({ page }) => {
  await setPolicy({ open: true, invite: false, verifyEmail: false });
  await page.goto("/register");
  await expect(page.getByLabel(/邀请码/)).toHaveCount(0);
  const name = unique("open");
  await fillAccount(page, name);
  await page.getByRole("button", { name: "注册" }).click();
  await expect(page.getByRole("button", { name })).toBeVisible();
});

test("双关：注册页显示「当前不开放注册」且没有注册表单", async ({ page }) => {
  await setPolicy({ open: false, invite: false, verifyEmail: false });
  await page.goto("/register");
  await expect(page.getByTestId("register-closed")).toBeVisible();
  await expect(page.getByLabel("用户名")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("link", { name: "登录" })).toBeVisible();
});

test("双关：页面加载后站长关闭注册，用旧表单提交被动作层拒绝，不建账号", async ({ page }) => {
  // 先在开放注册下拿到完整表单，再把策略切成双关——模拟「访客开着页面时站长关了注册」
  await setPolicy({ open: true, invite: false, verifyEmail: false });
  await page.goto("/register");
  const name = unique("closed");
  await fillAccount(page, name);
  await setPolicy({ open: false, invite: false, verifyEmail: false });
  await page.getByRole("button", { name: "注册" }).click();
  await expect(page.getByText("当前不开放注册").first()).toBeVisible();
  await withE2eDb(async (q) => {
    expect(await q.query("SELECT id FROM users WHERE username = ?", [name])).toHaveLength(0);
  });
});

test("双开：填有效邀请码走邀请路径，邀请码被核销", async ({ page }) => {
  await setPolicy({ open: true, invite: true, verifyEmail: false });
  await page.goto("/register");
  await expect(page.getByLabel("邀请码（选填）")).toBeVisible();
  const withCode = unique("both_inv");
  await page.getByLabel("邀请码（选填）").fill("E2E-INVITE-CODE");
  await fillAccount(page, withCode);
  await page.getByRole("button", { name: "注册" }).click();
  await expect(page.getByRole("button", { name: withCode })).toBeVisible();
  await withE2eDb(async (q) => {
    const rows = await q.query<{ used_by: number | null }>(
      "SELECT used_by FROM invite_codes WHERE code = 'E2E-INVITE-CODE'",
    );
    expect(rows[0]?.used_by).not.toBeNull(); // 邀请码被核销
  });
});

test("双开：邀请码留空走开放路径——注册成功且邀请码未被核销", async ({ page }) => {
  await setPolicy({ open: true, invite: true, verifyEmail: false });
  await page.goto("/register");
  const name = unique("blank");
  await fillAccount(page, name);
  await page.getByRole("button", { name: "注册" }).click();
  await expect(page.getByRole("button", { name })).toBeVisible();
  await withE2eDb(async (q) => {
    const rows = await q.query<{ used_by: number | null }>(
      "SELECT used_by FROM invite_codes WHERE code = 'E2E-INVITE-CODE'",
    );
    expect(rows[0]?.used_by ?? null).toBeNull(); // 走的是开放路径，没碰邀请码
  });
});

test("双开：填了无效邀请码报错，不降级成开放注册", async ({ page }) => {
  await setPolicy({ open: true, invite: true, verifyEmail: false });
  await page.goto("/register");
  const name = unique("both_bad");
  await page.getByLabel("邀请码（选填）").fill("NO-SUCH-CODE");
  await fillAccount(page, name);
  await page.getByRole("button", { name: "注册" }).click();
  await expect(page.getByText("邀请码无效或已被使用")).toBeVisible();
  await withE2eDb(async (q) => {
    const rows = await q.query("SELECT id FROM users WHERE username = ?", [name]);
    expect(rows).toHaveLength(0); // 没有悄悄建出开放注册的账号
  });
});

test("开放注册要求验证：注册后不建会话，跳登录页提示查收邮件，并发出验证邮件", async ({ page }) => {
  await setPolicy({ open: true, invite: false, verifyEmail: true });
  await page.goto("/register");
  await expect(page.getByText(/注册后需先验证邮箱才能登录/)).toBeVisible();
  const name = unique("verify");
  const email = `${name}@test.local`;
  const before = new Set(
    (
      (await (await fetch(`${MAIL_API}/messages`)).json()) as { messages: { ID: string }[] }
    ).messages.map((m) => m.ID),
  );
  await fillAccount(page, name);
  await page.getByRole("button", { name: "注册" }).click();

  await expect(page).toHaveURL(/\/login\?message=/);
  await expect(page.getByText(/请查收邮箱/)).toBeVisible();
  // 没有会话：不应出现用户菜单
  await expect(page.getByRole("button", { name })).toHaveCount(0);
  expect((await page.context().cookies()).find((c) => c.name === "fw_session")).toBeUndefined();

  await expect
    .poll(
      async () => {
        const list = (await (await fetch(`${MAIL_API}/messages`)).json()) as {
          messages: { ID: string; To: { Address: string }[]; Subject: string }[];
        };
        return list.messages.some(
          (m) =>
            !before.has(m.ID) &&
            m.Subject.includes("验证邮箱") &&
            m.To.some((t) => t.Address === email),
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await withE2eDb(async (q) => {
    const [u] = await q.query<{
      email_verification_required: number;
      login_verification_required: number;
    }>(
      "SELECT email_verification_required, login_verification_required FROM users WHERE username = ?",
      [name],
    );
    expect(u).toMatchObject({ email_verification_required: 1, login_verification_required: 1 });
  });
});
