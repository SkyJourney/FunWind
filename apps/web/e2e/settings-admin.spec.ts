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
  await admin.goto("/admin/invites?page=999999");
  const invitePageLabel = admin.getByText(/第 \d+\/\d+ 页/);
  await expect(invitePageLabel).toBeVisible();
  const invitePageMatch = (await invitePageLabel.textContent())?.match(/第 (\d+)\/(\d+) 页/);
  expect(invitePageMatch).not.toBeNull();
  expect(invitePageMatch?.[1]).toBe(invitePageMatch?.[2]);
  await admin.goto("/admin/invites");
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

test("审计日志越界页码标签显示夹取后的实际页", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginAs(ctx, USERS.admin);
  const admin = await ctx.newPage();
  await admin.goto("/admin/logs?page=999999");
  const pageLabel = admin.getByText(/共 \d+ 条 · 第 \d+\/\d+ 页/);
  await expect(pageLabel).toBeVisible();
  const pageMatch = (await pageLabel.textContent())?.match(/第 (\d+)\/(\d+) 页/);
  expect(pageMatch).not.toBeNull();
  expect(pageMatch?.[1]).toBe(pageMatch?.[2]);
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

test("邮件组：测试邮件进 Mailpit", async ({ browser }) => {
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
  await ctx.close();
});

/**
 * 注册策略（M11.3）：两个独立开关 + 「开放注册需验证邮箱」。
 * 全站注册开关是共享状态，必须在 finally 里复原成邀请制，避免影响 auth.spec 等依赖邀请注册的用例。
 */
async function savePolicy(
  admin: Page,
  flags: { open: boolean; verify: boolean; invite: boolean },
): Promise<void> {
  await admin.goto("/admin/settings");
  const set = async (name: string, on: boolean) => {
    const box = admin.locator(`#register input[name="${name}"]`);
    if (on) await box.check();
    else await box.uncheck();
  };
  await set("open", flags.open);
  await set("verifyEmail", flags.verify);
  await set("invite", flags.invite);
  await submitAndWait(admin, "保存注册策略");
}

test("注册策略：两个开关独立保存；双关给出专门提示与页内警示；可复原", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginAs(ctx, USERS.admin);
  const admin = await ctx.newPage();
  try {
    // 默认（邀请制）：邀请开、开放关
    await admin.goto("/admin/settings");
    await expect(admin.locator('#register input[name="invite"]')).toBeChecked();
    await expect(admin.locator('#register input[name="open"]')).not.toBeChecked();
    await expect(admin.getByTestId("register-closed-warning")).toHaveCount(0);

    // 双开 + 要求验证：普通成功提示，设置回显
    await savePolicy(admin, { open: true, verify: true, invite: true });
    await expect(admin.getByText("注册策略已保存。", { exact: true })).toBeVisible();
    await expect(admin.locator('#register input[name="open"]')).toBeChecked();
    await expect(admin.locator('#register input[name="verifyEmail"]')).toBeChecked();
    await expect(admin.locator('#register input[name="invite"]')).toBeChecked();

    // 双关：专门提示 + 页内警示常驻
    await savePolicy(admin, { open: false, verify: false, invite: false });
    await expect(admin.getByText(/开放注册与邀请注册均已关闭/).first()).toBeVisible();
    await admin.goto("/admin/settings");
    await expect(admin.getByTestId("register-closed-warning")).toBeVisible();
  } finally {
    await savePolicy(admin, { open: false, verify: false, invite: true });
    await ctx.close();
  }
});
