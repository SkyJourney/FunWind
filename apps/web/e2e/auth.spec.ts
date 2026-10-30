import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { withE2eDb } from "./support/db";

/**
 * M4 · 用户与认证 E2E。
 * 夹具（e2e-reset 重建）：邀请码 E2E-INVITE-CODE / demo_alice(90001, 无密码, alice@demo.local) /
 * demo_banned(90003, 密码 e2e-banned-pass, 全局永久封禁)。
 * MailPit UI/API：http://127.0.0.1:8025
 */

const MAIL_API = "http://127.0.0.1:8025/api/v1";

/**
 * 取 `since` 之后到达的最新一封邮件里的链接。找回 / 认领邮件在响应之后才发（after()，M5.6 S3：响应时间不能泄露邮箱是否存在），
 * 所以页面提示出现时邮件可能还在路上，这里轮询到出现为止。
 * 必须按 `since` 过滤：MailPit 会跨次运行保留旧邮件，不过滤的话一见到旧邮件就返回，拿到的是上一次运行的过期令牌。
 */
async function latestLinkFor(email: string, subjectPart: string, since: number): Promise<string> {
  const deadline = Date.now() + 30_000; // dev 模式 after() 可能慢 10s+（Turbo 流收尾延迟），放宽轮询上限
  for (;;) {
    const res = await fetch(`${MAIL_API}/messages?limit=20`);
    const data = (await res.json()) as {
      messages: { ID: string; Created: string; To: { Address: string }[]; Subject: string }[];
    };
    const mail = (data.messages ?? []).find(
      (m) =>
        m.To.some((t) => t.Address === email) &&
        m.Subject.includes(subjectPart) &&
        Date.parse(m.Created) >= since,
    );
    if (mail) {
      const full = (await (await fetch(`${MAIL_API}/message/${mail.ID}`)).json()) as {
        HTML: string;
      };
      const link = full.HTML.match(/href="(http[^"]+)"/)?.[1];
      if (!link) throw new Error("邮件中未找到链接");
      return link;
    }
    if (Date.now() > deadline) throw new Error(`未找到邮件: ${email} / ${subjectPart}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test.describe.configure({ mode: "serial" });

test.describe("M4 · 用户与认证", () => {
  const USERNAME = `e2e_user_${Date.now() % 100000}`;
  const EMAIL = `${USERNAME}@test.local`;
  const PASSWORD = "e2e-password-123";

  test("保留用户名被拒（M6.1），且被拒的尝试不会烧掉邀请码——紧接着的正常注册仍能用同一个邀请码", async ({
    page,
  }) => {
    for (const name of ["Admin2", "青翼官方客服"]) {
      await page.goto("/register");
      await page.getByLabel("邀请码").fill("E2E-INVITE-CODE");
      await page.getByLabel("用户名").fill(name);
      await page.getByLabel("邮箱").fill("reserved@test.local");
      await page.getByLabel("密码（至少 8 位）").fill("e2e-password-123");
      await page.getByRole("button", { name: "凭邀请码注册" }).click();
      await expect(page.getByText("该用户名不可用")).toBeVisible();
    }
    await withE2eDb(async (q) => {
      const rows = await q.query<{ used_by: number | null }>(
        "SELECT used_by FROM invite_codes WHERE code = 'E2E-INVITE-CODE'",
      );
      expect(rows[0]?.used_by ?? null).toBeNull(); // 邀请码仍未被核销
    });
  });

  test("邀请注册 → 自动登录 → 退出", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("邀请码").fill("E2E-INVITE-CODE");
    await page.getByLabel("用户名").fill(USERNAME);
    await page.getByLabel("邮箱").fill(EMAIL);
    await page.getByLabel("密码（至少 8 位）").fill(PASSWORD);
    await page.getByRole("button", { name: "凭邀请码注册" }).click();

    await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$|\/$/);
    // M10.5 用户区收进顶栏菜单：触发按钮的可达名含用户名
    await expect(page.getByRole("button", { name: USERNAME })).toBeVisible();

    // Cookie 安全属性（http 站点 Secure=false；HttpOnly 无法由 JS 读取——经 context 断言）
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "fw_session");
    expect(session).toBeDefined();
    expect(session!.httpOnly).toBe(true);
    expect(session!.sameSite).toBe("Lax");
    expect(session!.secure).toBe(false); // http 环境自动判定

    // 退出（M10.5 起在用户菜单内）
    await page.getByRole("button", { name: USERNAME }).click();
    await page.getByRole("button", { name: "退出" }).click();
    await expect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();
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
    test.setTimeout(90_000); // dev 模式页面导航慢，重置+登出+重登全流程超 30s
    await page.goto("/forgot");
    await page.getByLabel("注册邮箱").fill(EMAIL);
    const since = Date.now() - 1000; // 容忍时间戳取整
    await page.getByRole("button", { name: "发送邮件" }).click();
    await expect(page.getByText("若该邮箱已注册，邮件已发出")).toBeVisible();

    const link = await latestLinkFor(EMAIL, "重置密码", since);
    await page.goto(link.replace("http://127.0.0.1:3100", ""));
    await page.getByLabel("新密码（至少 8 位）").fill("new-pass-456");
    await page.getByLabel("确认新密码").fill("new-pass-456");
    await page.getByRole("button", { name: "保存并登录" }).click();

    // M10.6c：重置并登录——直接进站，不再回登录页重输
    await expect(page).toHaveURL(/\/(\?notice=password-reset)?$/);
    await expect(page.getByRole("button", { name: USERNAME })).toBeVisible();

    // 退出后再用新密码登录（验证新密码落库）
    await page.getByRole("button", { name: USERNAME }).click();
    await page.getByRole("button", { name: "退出" }).click();
    await expect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill(EMAIL);
    await page.getByLabel("密码", { exact: true }).fill("new-pass-456");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByRole("button", { name: USERNAME })).toBeVisible();
  });

  test("认领流程（无密码老账户 demo_alice）：邮件链接 → 设密 → 登录", async ({ page }) => {
    test.setTimeout(90_000); // 同上：邮件轮询 + 多次导航
    await page.goto("/forgot");
    await page.getByLabel("注册邮箱").fill("alice@demo.local");
    const since = Date.now() - 1000;
    await page.getByRole("button", { name: "发送邮件" }).click();
    await expect(page.getByText("若该邮箱已注册，邮件已发出")).toBeVisible();

    const link = await latestLinkFor("alice@demo.local", "认领", since);
    await page.goto(link.replace("http://127.0.0.1:3100", ""));
    await page.getByLabel("新密码（至少 8 位）").fill("alice-pass-789");
    await page.getByLabel("确认新密码").fill("alice-pass-789");
    await page.getByRole("button", { name: "认领并登录" }).click();

    // M10.6c：认领并登录——设密成功直接建立会话进入站点
    await expect(page).toHaveURL(/\/(\?notice=claimed)?$/);
    await expect(page.getByRole("button", { name: "demo_alice" })).toBeVisible();
  });

  test("登录失败统一话术（防枚举）", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("no_such_user_xyz");
    await page.getByLabel("密码", { exact: true }).fill("whatever123");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("用户名或密码错误")).toBeVisible();

    await page.getByLabel("用户名或邮箱").fill(EMAIL);
    await page.getByLabel("密码", { exact: true }).fill("wrong-pass");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("用户名或密码错误")).toBeVisible();
  });

  test("封禁用户登录被拒并展示理由", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("demo_banned");
    await page.getByLabel("密码", { exact: true }).fill("e2e-banned-pass");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText(/账号已被封禁/)).toBeVisible();
    await expect(page.getByText(/E2E 封禁夹具/)).toBeVisible();
  });

  test("邮箱验证确认页：GET 不消费令牌（邮件扫描器预取不会让链接失效），点按钮才消费，之后同一链接无效", async ({
    page,
    request,
  }) => {
    const token = randomBytes(32).toString("base64url");
    const id = createHash("sha256").update(token).digest("hex");
    const usedAt = () =>
      withE2eDb((q) =>
        q.query<{ used_at: string | null }>("SELECT used_at FROM email_tokens WHERE id = ?", [id]),
      );
    const [verifyUser] = await withE2eDb((q) =>
      q.query<{ email_key: string | null }>("SELECT email_key FROM users WHERE id = ?", [90001]),
    );
    expect(verifyUser?.email_key).toBeTruthy();
    const emailSnapshot = createHash("sha256").update(verifyUser!.email_key!).digest("hex");
    await withE2eDb((q) =>
      q.exec(
        "INSERT INTO email_tokens (id, purpose, user_id, email_key_snapshot, created_at, expires_at) VALUES (?, 'verify', 90001, ?, NOW(), NOW() + INTERVAL 1 DAY)",
        [id, emailSnapshot],
      ),
    );
    try {
      // 模拟邮件扫描器 / 链接预览：反复 GET
      for (let i = 0; i < 3; i++) {
        const res = await request.get(`/verify/${token}`);
        expect(res.status()).toBe(200);
        expect(await res.text()).toContain("确认验证邮箱");
      }
      expect((await usedAt())[0]!.used_at).toBeNull(); // 仍未被消费

      await page.goto(`/verify/${token}`);
      await page.getByRole("button", { name: "确认验证邮箱" }).click();
      await expect(page.getByText("邮箱验证完成，请登录")).toBeVisible();
      expect((await usedAt())[0]!.used_at).not.toBeNull();

      // 对照：已消费的令牌再点按钮是无效链接
      await page.goto(`/verify/${token}`);
      await page.getByRole("button", { name: "确认验证邮箱" }).click();
      await expect(page.getByText("验证链接无效或已过期")).toBeVisible();
    } finally {
      await withE2eDb((q) => q.exec("DELETE FROM email_tokens WHERE id = ?", [id]));
    }
  });

  test("登录页的“忘记密码 / 认领老账号”可达（此前指向不存在的 /claim）", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "忘记密码 / 认领老账号" }).click();
    await expect(page).toHaveURL(/\/forgot$/);
    await expect(page.getByRole("button", { name: "发送邮件" })).toBeVisible();
  });

  // M5.6 S2（审查 C2）。放在最后：这里会让 USERNAME 的 (IP, 标识符) 桶满，它之后不能再被其他用例用到。
  // 失败只占 IP 桶 12 个名额（上限 20，见 lib/auth/login.ts），成功登录不占额度，不会挤爆其他用例
  test("登录频控：存在与不存在的账号在同一次数后同样提示“过于频繁”（不泄露存在性），别的账号不受牵连", async ({
    page,
  }) => {
    const attempt = async (ident: string, pw: string) => {
      await page.goto("/login");
      await page.getByLabel("用户名或邮箱").fill(ident);
      await page.getByLabel("密码", { exact: true }).fill(pw);
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
    await page.getByLabel("密码", { exact: true }).fill("e2e-banned-pass");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText(/账号已被封禁/)).toBeVisible();
    await expect(page.getByText("尝试过于频繁")).toHaveCount(0);
  });
});
