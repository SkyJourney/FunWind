import { expect, test } from "@playwright/test";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * 错误路径回归（审查批次 1，F-01/F-02/F-13/F-14）：
 * 此前 closure/appeal/delete-account 三线的 18 处错误跳转把中文直接拼进 URL，Next 把跳转地址
 * 原样写进响应头导致 500（3100 实机复现：输错密码见「页面开小差了」）。本 spec 锁住这些路径：
 * 错误文案可见、无 500、频控与末位站长保护等特殊分支可达。
 */
failOnPageErrors();

test.describe.configure({ mode: "serial" });

const IDENTIFIER = "demo_alice";
const WRONG_PASSWORD = "definitely-wrong-password";

test("注销页输错密码：看到错误文案而不是 500（F-01 主回归）", async ({ page }) => {
  await page.goto("/closure");
  await page.fill('input[name="identifier"]', IDENTIFIER);
  await page.fill('input[name="current"]', WRONG_PASSWORD);
  await page.check('input[name="confirm"]');
  await page.locator("form").first().locator('button[type="submit"]').click();

  await expect(page.getByText("无法验证账号，请检查登录名和密码")).toBeVisible();
  await expect(page.getByText("页面开小差了")).toHaveCount(0);
  await expect(page).toHaveURL(/\/closure\?error=/);
});

test("注销页频控：同一标识符连续提交到限额后提示操作频繁", async ({ page }) => {
  // 独立标识符（自己的 5 次/小时桶，不与其它用例共享配额）；每次提交都等 POST 响应落地，杜绝竞态
  const ident = "rate-limit-audit-user";
  await page.goto("/closure");
  for (let i = 0; i < 6; i++) {
    await page.fill('input[name="identifier"]', ident);
    await page.fill('input[name="current"]', WRONG_PASSWORD);
    await page.check('input[name="confirm"]');
    const posted = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/closure",
    );
    await page.locator("form").first().locator('button[type="submit"]').click();
    const response = await posted;
    expect(response.status()).toBeLessThan(400);
    await expect(page.getByRole("button", { name: "验证状态或申请注销" })).toBeEnabled();
  }
  await expect(page.getByText("操作过于频繁")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("页面开小差了")).toHaveCount(0);
});

test("注销页末位站长保护：正确密码也给出明确拒绝（而非 500）", async ({ page }) => {
  await page.goto("/closure");
  await page.fill('input[name="identifier"]', "demo_admin");
  await page.fill('input[name="current"]', "e2e-admin-pass"); // 种子演示账户共用明文（seed-data.ts）
  await page.check('input[name="confirm"]');
  await page.locator("form").first().locator('button[type="submit"]').click();
  await expect(page.getByText("这是最后一位有效站点管理员，不能申请注销")).toBeVisible();
  await expect(page.getByText("页面开小差了")).toHaveCount(0);
});

test("设置里申请注销：当前密码错误给出文案（此前同款未编码跳转）", async ({ context, page }) => {
  await loginAs(context, USERS.member);
  await page.goto("/settings/delete-account");
  await page.fill('input[name="current"]', WRONG_PASSWORD);
  await page.getByRole("button", { name: "确认申请注销" }).click();
  await expect(page.getByText("当前密码不正确，请重新验证。")).toBeVisible();
  await expect(page.getByText("页面开小差了")).toHaveCount(0);
});

test("申诉页频控：同一标识符连续提交后错误提示不 500（F-01）", async ({ page }) => {
  const ident = "appeal-rate-audit-user";
  await page.goto("/appeal");
  for (let i = 0; i < 6; i++) {
    await page.fill('input[name="identifier"]', ident);
    await page.fill('input[name="current"]', WRONG_PASSWORD);
    await page.fill('textarea[name="reason"]', `rate-limit-attempt-${i}`);
    const posted = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/appeal",
    );
    await page.getByRole("button", { name: "提交人工复核" }).click();
    const response = await posted;
    expect(response.status()).toBeLessThan(400);
    await expect(page.getByRole("button", { name: "提交人工复核" })).toBeEnabled();
  }
  await expect(page.getByText("操作过于频繁")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("页面开小差了")).toHaveCount(0);
});

test("版主进后台落在内容审核队列（F-02）；会员访问 404（F-14）", async ({ browser }) => {
  const mod = await browser.newContext();
  await loginAs(mod, USERS.team);
  const modPage = await mod.newPage();
  await modPage.goto("/admin");
  await expect(modPage).toHaveURL(/\/admin\/review$/);
  // 审核队列可见（版主的落点就是自己的大本营）；精确匹配导航链接，避免命中空态文案
  await expect(modPage.getByRole("link", { name: "待审核", exact: true })).toBeVisible();
  // 公告与私信管理归站长：版主既看不到菜单，直接访问也不能取到页面。
  const nav = modPage.getByRole("navigation");
  for (const name of ["主题管理", "公告", "私信管理"]) {
    await expect(nav.getByRole("link", { name, exact: true })).toHaveCount(0);
  }
  for (const path of ["/admin/announcements", "/admin/pm"]) {
    expect((await modPage.goto(path))?.status(), path).toBe(404);
  }
  await mod.close();

  const member = await browser.newContext();
  await loginAs(member, USERS.member);
  const memberPage = await member.newPage();
  const res = await memberPage.goto("/admin");
  expect(res?.status()).toBe(404);
  await member.close();
});

test("关闭 JavaScript 的表单提交仍以编码后的 303 跳转显示错误", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto("/closure");
    await page.fill('input[name="identifier"]', "no-js-audit-user");
    await page.fill('input[name="current"]', WRONG_PASSWORD);
    await page.check('input[name="confirm"]');
    const posted = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/closure",
    );
    await page.getByRole("button", { name: "验证状态或申请注销" }).click();
    const response = await posted;
    expect(response.status()).toBe(303);
    const location = response.headers()["location"];
    expect(location).toMatch(/^[\x20-\x7e]+$/);
    expect(new URL(location!, "http://127.0.0.1:3201").searchParams.get("error")).toBe(
      "无法验证账号，请检查登录名和密码",
    );
    await expect(page.getByText("无法验证账号，请检查登录名和密码")).toBeVisible();
  } finally {
    await context.close();
  }
});
