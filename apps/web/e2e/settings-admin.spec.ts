import { expect, test, type Page } from "@playwright/test";
import { USERS, loginAs } from "./support/session";

/**
 * 站点配置 E2E（M10.6b）：邀请码生成→撤销→已用保护由界面走查；robots/sitemap 公开可达且边界正确。
 * 站点身份改动是全局变更——与并行用例的站名断言（content/modules.spec 首页 h1）有竞态，
 * 故不进 E2E：解析回退由 site-chrome.identity.test 覆盖，生效链路由目视验收覆盖。
 */

test.describe.configure({ mode: "serial" });

async function submitAndWait(page: Page, button: string): Promise<void> {
  const resp = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined,
  );
  await page.getByRole("button", { name: button }).click();
  await resp;
}

test("游客与会员访问站点配置/邀请码 → 404（越权不暴露）", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAs(ctx, USERS.member);
  expect((await page.goto("/admin/settings"))?.status()).toBe(404);
  expect((await page.goto("/admin/invites"))?.status()).toBe(404);
  await ctx.close();
});

test("邀请码：生成 → 列表可用 → 撤销 → 消失", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginAs(ctx, USERS.admin);
  const admin = await ctx.newPage();

  await admin.goto("/admin/invites");
  await expect(admin.getByRole("heading", { name: "邀请码" })).toBeVisible();
  const before = await admin.getByText("可用", { exact: true }).count();

  await admin.getByLabel("数量（1–20）").fill("2");
  await admin.getByLabel("批次备注").fill("e2e 批次");
  await submitAndWait(admin, "生成");
  await expect(admin.getByText(/已生成 2 枚邀请码/)).toBeVisible();
  const rows = admin.locator("div.rounded-lg.border").filter({ hasText: "e2e 批次" });
  await expect(rows).toHaveCount(2);

  // 撤销第一枚
  await rows.first().getByRole("button", { name: "撤销" }).click();
  await expect(admin.getByRole("dialog")).toBeVisible();
  await submitAndWait(admin, "确认");
  await expect(rows).toHaveCount(1);

  const after = await admin.getByText("可用", { exact: true }).count();
  expect(after).toBe(before + 1);
  await ctx.close();
});

test("robots 与 sitemap：可达、私有面不进索引", async ({ page }) => {
  const robots = await page.goto("/robots.txt");
  expect(robots?.status()).toBe(200);
  const robotsText = (await robots?.text()) ?? "";
  expect(robotsText).toContain("Disallow: /admin");
  expect(robotsText).toContain("sitemap.xml");

  const sitemap = await page.goto("/sitemap.xml");
  expect(sitemap?.status()).toBe(200);
  const sitemapText = (await sitemap?.text()) ?? "";
  expect(sitemapText).toContain("/boards");
  expect(sitemapText).not.toContain("/admin");
});

test("邮件组：测试邮件进 Mailpit；always 策略下邀请注册也收验证邮件", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginAs(ctx, USERS.admin);
  const admin = await ctx.newPage();

  // 测试邮件：发到当前管理员邮箱（demo admin = admin@demo.local）
  await admin.goto("/admin/settings");
  await admin.getByRole("button", { name: /发送测试邮件/ }).click();
  await admin.waitForURL("**/admin/settings?saved=mail_sent");
  await expect(admin.getByText("测试邮件已发出")).toBeVisible();
  await expect
    .poll(
      async () => {
        const list = (await (
          await admin.request.get("http://127.0.0.1:8025/api/v1/messages")
        ).json()) as {
          messages: { ID: string; To: { Address: string }[]; Subject: string }[];
        };
        return list.messages.some(
          (m) =>
            m.Subject.includes("测试邮件") && m.To.some((t) => t.Address === "admin@demo.local"),
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  // 验证策略切到 always
  await admin.getByRole("radio", { name: /所有新账号验证/ }).check();
  await admin.getByRole("button", { name: "保存验证策略" }).click();
  await admin.waitForURL("**/admin/settings?saved=email_verification");
  await expect(admin.getByText("邮箱验证策略已保存")).toBeVisible();

  // 生成一枚新邀请码并注册（不碰 auth.spec 的固定码）
  await admin.goto("/admin/invites");
  await admin.getByLabel("数量（1–20）").fill("1");
  await admin.getByLabel("批次备注").fill("e2e 验证策略");
  await admin.getByRole("button", { name: "生成" }).click();
  await admin.waitForURL(/\/admin\/invites\?saved=1&batch=/);
  const codeRow = admin
    .locator("div.rounded-lg.border")
    .filter({ hasText: "e2e 验证策略" })
    .first();
  const inviteCode = await codeRow.locator("code").first().innerText();

  // 管理员退出 → 用邀请码注册 → 应收到验证邮件并看到 verify-email-sent 提示
  // 用户菜单触发按钮的可达名 = 用户名（M10.5 起菜单化）
  await admin.getByRole("button", { name: "demo_admin" }).click();
  await admin.getByRole("button", { name: "退出" }).click();
  await expect(admin.getByRole("link", { name: "登录", exact: true })).toBeVisible();
  await admin.goto("/register");
  const username = `e2e_ev_${Date.now() % 100000}`;
  await admin.getByLabel("邀请码").fill(inviteCode);
  await admin.getByLabel("用户名").fill(username);
  await admin.getByLabel("邮箱").fill(`${username}@test.local`);
  await admin.getByLabel("密码（至少 8 位）").fill("e2e-password-123");
  await admin.getByRole("button", { name: "凭邀请码注册" }).click();
  await admin.waitForURL("**/?notice=verify-email-sent");
  await expect
    .poll(
      async () => {
        const list = (await (
          await admin.request.get("http://127.0.0.1:8025/api/v1/messages")
        ).json()) as {
          messages: { ID: string; To: { Address: string }[]; Subject: string }[];
        };
        return list.messages.some(
          (m) =>
            m.Subject.includes("验证邮箱") &&
            m.To.some((t) => t.Address === `${username}@test.local`),
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  // 复原策略（open_only），避免影响其他用例的注册语义
  const adminCtx2 = await browser.newContext();
  await loginAs(adminCtx2, USERS.admin);
  const admin2 = await adminCtx2.newPage();
  await admin2.goto("/admin/settings");
  await admin2.getByRole("radio", { name: /开放注册新账号验证/ }).check();
  await admin2.getByRole("button", { name: "保存验证策略" }).click();
  await admin2.waitForURL("**/admin/settings?saved=email_verification");
  await adminCtx2.close();
  await ctx.close();
});
