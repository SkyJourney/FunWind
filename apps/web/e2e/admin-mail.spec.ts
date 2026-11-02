import { expect, test } from "@playwright/test";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/** 邮件专项（批次 0）：发送记录（email_log）后台可查 + 模板预览页 + 守卫同源。 */
failOnPageErrors();

test.describe.configure({ mode: "serial" });

test("会员访问邮件后台 404（admin.logs 守卫）", async ({ browser }) => {
  const context = await browser.newContext();
  await loginAs(context, USERS.member);
  const page = await context.newPage();
  const res = await page.goto("/admin/mail");
  expect(res?.status()).toBe(404);
  await context.close();
});

test("发送测试邮件后，发送记录可查可筛选", async ({ context, page }) => {
  await loginAs(context, USERS.admin);
  await page.goto("/admin/settings");
  await page.getByRole("button", { name: /^发送测试邮件/ }).click();
  await expect(page).toHaveURL(/saved=mail_sent/);

  await page.goto("/admin/mail");
  // 记录行：系统类 / test-mail 场景 / 成功
  const row = page.locator("tbody tr").filter({ hasText: "test-mail" }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("成功");
  await expect(row).toContainText("测试邮件 · ");

  // 按状态筛选：失败 → 空
  await page.getByLabel("状态").selectOption("failed");
  await page.getByRole("button", { name: "筛选" }).click();
  await expect(page).toHaveURL(/status=failed/);
  await expect(page.getByText("无记录。")).toBeVisible();

  // 按类别筛选：系统 → test-mail 在列
  await page.getByLabel("状态").selectOption("");
  await page.getByLabel("类别").selectOption("system");
  await page.getByRole("button", { name: "筛选" }).click();
  await expect(page.locator("tbody tr").filter({ hasText: "test-mail" }).first()).toBeVisible();

  // 导航存在且可达（菜单 need 与页面守卫同源，均为 admin.logs）
  await expect(page.getByRole("navigation").getByRole("link", { name: "邮件" })).toBeVisible();
});

test("模板预览页渲染样例并可在模板间切换", async ({ context, page }) => {
  await loginAs(context, USERS.admin);
  await page.goto("/admin/mail/preview");
  await expect(page.locator("iframe[title^='模板预览']")).toBeVisible();
  // 默认渲染第一个样例（验证邮箱）
  await expect(page.getByText("验证邮箱 · 青翼字幕组")).toBeVisible();

  // 切到私信模板：主题与纯文本对照都随样例变化
  await page.getByRole("link", { name: "收到私信" }).click();
  await expect(page).toHaveURL(/t=pm-received/);
  await expect(page.getByText("夜雨 给你发来了私信 · 青翼字幕组")).toBeVisible();
  await page.getByText("纯文本版本").click();
  await expect(page.getByText(/管理邮件提醒：/)).toBeVisible();

  // 回发送记录
  await page.getByRole("link", { name: "← 发送记录" }).click();
  await expect(page).toHaveURL(/\/admin\/mail$/);
});
