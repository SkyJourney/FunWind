import { expect, test } from "@playwright/test";

/**
 * M4 · 用户与认证 E2E。
 * 夹具（e2e-reset 重建）：邀请码 E2E-INVITE-CODE / demo_alice(90001, 无密码, alice@demo.local) /
 * demo_banned(90003, 密码 e2e-banned-pass, 全局永久封禁)。
 * MailPit UI/API：http://127.0.0.1:8025
 */

const MAIL_API = "http://127.0.0.1:8025/api/v1";

async function latestLinkFor(email: string, subjectPart: string): Promise<string> {
  const res = await fetch(`${MAIL_API}/messages?limit=20`);
  const data = (await res.json()) as {
    messages: { ID: string; To: { Address: string }[]; Subject: string }[];
  };
  const mail = (data.messages ?? []).find(
    (m) => m.To.some((t) => t.Address === email) && m.Subject.includes(subjectPart),
  );
  if (!mail) throw new Error(`未找到邮件: ${email} / ${subjectPart}`);
  const full = (await (await fetch(`${MAIL_API}/message/${mail.ID}`)).json()) as { HTML: string };
  const link = full.HTML.match(/href="(http[^"]+)"/)?.[1];
  if (!link) throw new Error("邮件中未找到链接");
  return link;
}

test.describe.configure({ mode: "serial" });

test.describe("M4 · 用户与认证", () => {
  const USERNAME = `e2e_user_${Date.now() % 100000}`;
  const EMAIL = `${USERNAME}@test.local`;
  const PASSWORD = "e2e-password-123";

  test("邀请注册 → 自动登录 → 退出", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("邀请码").fill("E2E-INVITE-CODE");
    await page.getByLabel("用户名").fill(USERNAME);
    await page.getByLabel("邮箱").fill(EMAIL);
    await page.getByLabel("密码（至少 8 位）").fill(PASSWORD);
    await page.getByRole("button", { name: "凭邀请码注册" }).click();

    await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$|\/$/);
    await expect(page.getByRole("link", { name: USERNAME })).toBeVisible();

    // Cookie 安全属性（http 站点 Secure=false；HttpOnly 无法由 JS 读取——经 context 断言）
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "fw_session");
    expect(session).toBeDefined();
    expect(session!.httpOnly).toBe(true);
    expect(session!.sameSite).toBe("Lax");
    expect(session!.secure).toBe(false); // http 环境自动判定

    // 退出
    await page.getByRole("button", { name: "退出" }).click();
    await expect(page.getByRole("link", { name: "登录" })).toBeVisible();
  });

  test("重复使用同一邀请码被拒", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("邀请码").fill("E2E-INVITE-CODE"); // 上一用例已核销
    await page.getByLabel("用户名").fill("e2e_dup_user");
    await page.getByLabel("邮箱").fill("dup@test.local");
    await page.getByLabel("密码（至少 8 位）").fill(PASSWORD);
    await page.getByRole("button", { name: "凭邀请码注册" }).click();
    await expect(page.getByText("邀请码无效或已被使用")).toBeVisible();
  });

  test("找回流程（已设密账户）：邮件链接 → 重置密码 → 新密码登录", async ({ page }) => {
    await page.goto("/forgot");
    await page.getByLabel("注册邮箱").fill(EMAIL);
    await page.getByRole("button", { name: "发送邮件" }).click();
    await expect(page.getByText("若该邮箱已注册，邮件已发出")).toBeVisible();

    const link = await latestLinkFor(EMAIL, "重置密码");
    await page.goto(link.replace("http://127.0.0.1:3100", ""));
    await page.getByLabel("新密码（至少 8 位）").fill("new-pass-456");
    await page.getByLabel("确认新密码").fill("new-pass-456");
    await page.getByRole("button", { name: "保存并登录" }).click();

    await expect(page).toHaveURL(/login/);
    await expect(page.getByText("密码已重置")).toBeVisible();

    await page.getByLabel("用户名或邮箱").fill(EMAIL);
    await page.getByLabel("密码").fill("new-pass-456");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByRole("link", { name: USERNAME })).toBeVisible();
  });

  test("认领流程（无密码老账户 demo_alice）：邮件链接 → 设密 → 登录", async ({ page }) => {
    await page.goto("/forgot");
    await page.getByLabel("注册邮箱").fill("alice@demo.local");
    await page.getByRole("button", { name: "发送邮件" }).click();
    await expect(page.getByText("若该邮箱已注册，邮件已发出")).toBeVisible();

    const link = await latestLinkFor("alice@demo.local", "认领");
    await page.goto(link.replace("http://127.0.0.1:3100", ""));
    await page.getByLabel("新密码（至少 8 位）").fill("alice-pass-789");
    await page.getByLabel("确认新密码").fill("alice-pass-789");
    await page.getByRole("button", { name: "认领并登录" }).click();

    await expect(page).toHaveURL(/login/);
    await expect(page.getByText("账号认领成功")).toBeVisible();
    await page.getByLabel("用户名或邮箱").fill("demo_alice");
    await page.getByLabel("密码").fill("alice-pass-789");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByRole("link", { name: "demo_alice" })).toBeVisible();
  });

  test("登录失败统一话术（防枚举）", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("no_such_user_xyz");
    await page.getByLabel("密码").fill("whatever123");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("用户名或密码错误")).toBeVisible();

    await page.getByLabel("用户名或邮箱").fill(EMAIL);
    await page.getByLabel("密码").fill("wrong-pass");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("用户名或密码错误")).toBeVisible();
  });

  test("封禁用户登录被拒并展示理由", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("demo_banned");
    await page.getByLabel("密码").fill("e2e-banned-pass");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText(/账号已被封禁/)).toBeVisible();
    await expect(page.getByText(/E2E 封禁夹具/)).toBeVisible();
  });

  // M5.6 S2（审查 C2）。放在最后：这里会让 USERNAME 的 (IP, 标识符) 桶满，它之后不能再被其他用例用到。
  // 失败只占 IP 桶 12 个名额（上限 20，见 lib/auth/login.ts），成功登录不占额度，不会挤爆其他用例
  test("登录频控：存在与不存在的账号在同一次数后同样提示“过于频繁”（不泄露存在性），别的账号不受牵连", async ({
    page,
  }) => {
    const attempt = async (ident: string, pw: string) => {
      await page.goto("/login");
      await page.getByLabel("用户名或邮箱").fill(ident);
      await page.getByLabel("密码").fill(pw);
      await page.getByRole("button", { name: "登录" }).click();
      const throttled = page.getByText("尝试过于频繁");
      const invalid = page.getByText("用户名或密码错误");
      await expect(throttled.or(invalid)).toBeVisible();
      return (await throttled.isVisible()) ? "throttled" : "invalid";
    };
    const run = async (ident: string) => {
      const seq: string[] = [];
      for (let i = 0; i < 6; i++) seq.push(await attempt(ident, "wrong-pass-xyz"));
      return seq;
    };
    const existing = await run(USERNAME);
    const missing = await run(`nobody_${Date.now() % 100000}`);
    expect(existing).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid", "throttled"]);
    expect(missing).toEqual(existing);

    // 对照：USERNAME 已被挡，但另一个账号（封禁夹具，密码正确）不受牵连，走到的是封禁提示而不是“过于频繁”
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("demo_banned");
    await page.getByLabel("密码").fill("e2e-banned-pass");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText(/账号已被封禁/)).toBeVisible();
    await expect(page.getByText("尝试过于频繁")).toHaveCount(0);
  });
});
