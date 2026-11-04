import { expect, test, type Browser, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { expectNoNewMail, snapshotMailIds, waitForNewMail } from "./support/mailpit";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * M11.3 清账：管理员在用户详情页代改邮箱并重新发起验证。
 *
 * 场景：用户注册时填错邮箱，登录门把他挡在外面，免登录重发又发回同一个错地址，自己解不开。
 * 站长拍板：留痕即可，不加理由与确认弹窗；不提供「手动标记已验证」，用户必须重走验证。
 * 注册策略是全站共享状态，直接写 register.policy，afterEach 删除该键复原为默认邀请制。
 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

const MAIL_API = "http://127.0.0.1:8025/api/v1";
const PASSWORD = "e2e-password-123";
const unique = (tag: string) => `e2e_${tag}_${Date.now() % 1_000_000}`;

async function setOpenWithVerify() {
  await withE2eDb((q) =>
    q.exec(
      "INSERT INTO site_settings (`key`, value, updated_at) VALUES ('register.policy', CAST(? AS JSON), NOW()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()",
      [JSON.stringify({ open: true, invite: false, verifyEmail: true })],
    ),
  );
}

test.afterEach(async () => {
  await withE2eDb((q) => q.exec("DELETE FROM site_settings WHERE `key` = 'register.policy'"));
});

/** 经界面注册一个要求验证的账号：注册后不建会话，跳登录页提示查收邮件 */
async function registerGated(page: Page, name: string, email: string) {
  await setOpenWithVerify();
  await page.goto("/register");
  await page.getByLabel("用户名").fill(name);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码（至少 8 位）").fill(PASSWORD);
  await page.getByRole("button", { name: "注册" }).click();
  await expect(page).toHaveURL(/\/login\?message=/);
}

async function login(page: Page, name: string) {
  await page.goto("/login");
  await page.getByLabel("用户名或邮箱").fill(name);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
}

const userIdOf = (name: string) =>
  withE2eDb(async (q) => {
    const [row] = await q.query<{ id: number }>("SELECT id FROM users WHERE username = ?", [name]);
    return row!.id;
  });

/** 以管理员身份打开某用户的详情页（独立上下文，不干扰访客页的 cookie） */
async function adminOn(browser: Browser, userId: number) {
  const context = await browser.newContext();
  await loginAs(context, USERS.admin);
  const page = await context.newPage();
  await page.goto(`/admin/users/${userId}`);
  return { context, page, panel: page.getByTestId("user-email-panel") };
}

async function submitNewEmail(panel: ReturnType<Page["getByTestId"]>, email: string) {
  await panel.getByLabel("新邮箱").fill(email);
  await panel.getByRole("button", { name: "修改邮箱并发送验证邮件" }).click();
}

async function verifyLinkOf(mailId: string): Promise<string> {
  const full = (await (await fetch(`${MAIL_API}/message/${mailId}`)).json()) as { HTML: string };
  const link = full.HTML.match(/href="(http[^"]*\/verify\/[^"]+)"/)?.[1];
  expect(link).toBeTruthy();
  return new URL(link!).pathname;
}

test("自救闭环：填错邮箱注册 → 登录被拦 → 管理员改邮箱 → 用户点新地址里的链接 → 能登录，并留下审计", async ({
  page,
  browser,
}) => {
  const name = unique("rescue");
  const typo = `${name}@tset.local`; // 故意填错的域名
  const right = `${name}@test.local`;
  await registerGated(page, name, typo);

  // 正确密码也被登录门拦下
  await login(page, name);
  await expect(page.getByText(/请先验证邮箱/)).toBeVisible();

  const userId = await userIdOf(name);
  const { context, page: admin, panel } = await adminOn(browser, userId);
  try {
    await expect(panel.getByTestId("user-email-current")).toHaveText(typo);
    await expect(panel.getByTestId("user-email-status")).toHaveText("注册后未验证，无法登录");

    const knownRight = await snapshotMailIds(right, "验证邮箱");
    const knownTypo = await snapshotMailIds(typo, ""); // 空主题 = 该地址的任何邮件
    await submitNewEmail(panel, right);

    await expect(admin).toHaveURL(/emailChanged=sent/);
    await expect(admin.getByText("邮箱已修改，验证邮件已发往新地址")).toBeVisible();
    await expect(panel.getByTestId("user-email-current")).toHaveText(right);
    // 门仍关着：必须点新地址里的链接，管理员改邮箱本身不放行登录
    await expect(panel.getByTestId("user-email-status")).toHaveText("注册后未验证，无法登录");

    // 新地址收到验证邮件；填错的旧地址从未被证明属于该用户，不发任何邮件（含安全告警）
    const mail = await waitForNewMail(right, "验证邮箱", knownRight);
    await expectNoNewMail(typo, "", knownTypo);

    // 用户点链接 → 首次验证成功，登录门解除 → 能登录
    await page.goto(await verifyLinkOf(mail.ID));
    await page.getByRole("button", { name: "确认验证邮箱" }).click();
    await expect(page.getByText("邮箱验证完成，请登录")).toBeVisible();
    await login(page, name);
    await expect(page.getByRole("button", { name })).toBeVisible();

    // 留痕：操作者是管理员，邮箱只记哈希不记明文
    await withE2eDb(async (q) => {
      const rows = await q.query<{ actor_id: number; before_json: string; after_json: string }>(
        "SELECT actor_id, before_json, after_json FROM audit_log WHERE action = 'admin.user.email.change' AND target_type = 'user' AND target_id = ?",
        [String(userId)],
      );
      expect(rows.map((r) => r.actor_id)).toEqual([USERS.admin]);
      const body = JSON.stringify([rows[0]!.before_json, rows[0]!.after_json]);
      expect(body).not.toContain(typo);
      expect(body).not.toContain(right);
    });
  } finally {
    await context.close();
  }
});

test("已验证账号被改邮箱：旧地址收到安全告警，新地址收到确认与验证邮件，回到写权限受限但仍能登录", async ({
  page,
  browser,
}) => {
  const name = unique("verified");
  const original = `${name}@test.local`;
  const changed = `${name}_new@test.local`;
  await registerGated(page, name, original);
  // 模拟用户已完成首次验证：邮箱已验证、登录门已解除
  await withE2eDb((q) =>
    q.exec(
      "UPDATE users SET email_verified_at = NOW(), login_verification_required = 0 WHERE username = ?",
      [name],
    ),
  );

  const userId = await userIdOf(name);
  const { context, page: admin, panel } = await adminOn(browser, userId);
  try {
    await expect(panel.getByTestId("user-email-status")).toHaveText("邮箱已验证");
    const knownAlert = await snapshotMailIds(original, "邮箱已更换");
    const knownVerify = await snapshotMailIds(changed, "验证邮箱");
    await submitNewEmail(panel, changed);
    await expect(admin).toHaveURL(/emailChanged=sent/);
    await expect(panel.getByTestId("user-email-status")).toHaveText("邮箱待验证（写入受限）");

    await waitForNewMail(original, "邮箱已更换", knownAlert); // 旧地址告警
    await waitForNewMail(changed, "验证邮箱", knownVerify); // 新地址验证邮件

    // 改绑只拦写权限，不拦登录（Q9b）
    await login(page, name);
    await expect(page.getByRole("button", { name })).toBeVisible();
  } finally {
    await context.close();
  }
});

test.describe("错误路径", () => {
  test("非管理员访问用户详情页 → 404（越权对外表现为 404，看不到邮箱卡片）", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await loginAs(context, USERS.member);
    const page = await context.newPage();
    try {
      const response = await page.goto(`/admin/users/${USERS.alice}`);
      expect(response?.status()).toBe(404);
      await expect(page.getByTestId("user-email-panel")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("管理员提交非法格式 / 已被占用的邮箱 → 页面提示具体原因，原邮箱不变", async ({
    browser,
  }) => {
    const { context, page, panel } = await adminOn(browser, USERS.alice);
    try {
      const before = await panel.getByTestId("user-email-current").innerText();

      // 浏览器的 type=email 会先拦住非法格式；关掉前端校验，验证服务端也拒绝
      await page
        .locator("form:has(input[name='email'])")
        .evaluate((f) => ((f as HTMLFormElement).noValidate = true));
      await submitNewEmail(panel, "not-an-email");
      await expect(page.getByRole("alert").filter({ hasText: "邮箱格式不正确" })).toBeVisible();

      // 演示用户 member 占用的邮箱
      await submitNewEmail(panel, "member@demo.local");
      await expect(
        page.getByRole("alert").filter({ hasText: "该邮箱已被其他账号使用" }),
      ).toBeVisible();

      await expect(panel.getByTestId("user-email-current")).toHaveText(before);
    } finally {
      await context.close();
    }
  });

  test("用户不存在 → 404；邮件发送失败的警示参数在页面上有消费者", async ({ browser }) => {
    const { context, page } = await adminOn(browser, USERS.alice);
    try {
      expect((await page.goto("/admin/users/987654321"))?.status()).toBe(404);
      // G-15：emailChanged=failed 必须渲染成警示，不能是静默失败
      await page.goto(`/admin/users/${USERS.alice}?emailChanged=failed`);
      await expect(page.getByRole("alert").filter({ hasText: "验证邮件发送失败" })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
