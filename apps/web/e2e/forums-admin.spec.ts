import { expect, test, type Page } from "@playwright/test";
import { USERS, loginAs } from "./support/session";

/**
 * 板块管理 E2E（M10.6a）：非管理员越权 404；创建分区/版块 → 目录可见；
 * isListed 关 = 不上目录但仍可直达；readPolicy=restricted = 游客 404、管理员可读；
 * 空版块删除（ConfirmSubmit）→ 列表消失。
 * 服务端环检测/删除保护由 lib/forums 单测+集成测试覆盖。
 */

test.describe.configure({ mode: "serial" });

/** 等 Server Action 的 POST 返回（next-action 头），规避"同 URL 重定向立即满足"与提交竞跑 */
async function submitAndWait(page: Page, button = "保存"): Promise<void> {
  const resp = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined,
  );
  await page.getByRole("button", { name: button }).click();
  await resp;
}

test("非管理员访问板块管理 → 404（越权不暴露后台存在）", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAs(ctx, USERS.member);
  const res = await page.goto("/admin/forums");
  expect(res?.status()).toBe(404);
  await ctx.close();
});

test("板块管理全链路：创建 → 目录可见 → 上目录开关 → restricted → 删除", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await loginAs(adminCtx, USERS.admin);
  const admin = await adminCtx.newPage();
  const guest = await (await browser.newContext()).newPage();

  await admin.goto("/admin/forums");
  await expect(admin.getByRole("heading", { name: "板块管理" })).toBeVisible();

  // 创建分区
  await admin.getByLabel("名称").fill("E2E 板块分区");
  await admin.getByLabel("父级").selectOption("0");
  await admin.getByLabel("类型").selectOption("section");
  await submitAndWait(admin, "创建");
  await admin.waitForURL(/\/admin\/forums\/\d+$/);
  const sectionId = Number(admin.url().split("/").pop());

  // 分区内创建版块
  await admin.goto("/admin/forums");
  await admin.getByLabel("名称").fill("E2E 测试版块");
  await admin.getByLabel("父级").selectOption({ label: "［分区］E2E 板块分区" });
  await submitAndWait(admin, "创建");
  await admin.waitForURL(/\/admin\/forums\/\d+$/);
  const forumId = Number(admin.url().split("/").pop());
  expect(forumId).not.toBe(sectionId);

  // 游客：目录可见，直达可读
  await guest.goto("/boards");
  await expect(guest.getByText("E2E 测试版块").first()).toBeVisible();
  expect((await guest.goto(`/f/${forumId}`))?.status()).toBe(200);

  // 关闭「上目录」：目录不再展示，公开直达仍可读
  await admin.goto(`/admin/forums/${forumId}`);
  await admin.getByLabel("出现在首页与目录").uncheck();
  await submitAndWait(admin);
  await guest.goto("/boards");
  await expect(guest.getByText("E2E 测试版块")).toHaveCount(0);
  expect((await guest.goto(`/f/${forumId}`))?.status()).toBe(200);

  // restricted：游客直达 404，管理员仍可读
  await admin.goto(`/admin/forums/${forumId}`);
  await admin.getByLabel("可见性 readPolicy").selectOption("restricted");
  await submitAndWait(admin);
  expect((await guest.goto(`/f/${forumId}`))?.status()).toBe(404);
  expect((await admin.goto(`/f/${forumId}`))?.status()).toBe(200);

  // 删除测试版块（无主题 → 可删；ConfirmSubmit 确认后行消失）
  await admin.goto("/admin/forums");
  const forumRow = admin.getByTestId(`forum-row-${forumId}`);
  await forumRow.getByRole("button", { name: "删除" }).click();
  await expect(admin.getByText("删除「E2E 测试版块」？")).toBeVisible();
  await submitAndWait(admin, "确认");
  await expect(admin.getByTestId(`forum-row-${forumId}`)).toHaveCount(0);

  // 分区已空 → 可删
  await admin.goto("/admin/forums");
  await admin.getByTestId(`forum-row-${sectionId}`).getByRole("button", { name: "删除" }).click();
  await expect(admin.getByText("删除「E2E 板块分区」？")).toBeVisible();
  await submitAndWait(admin, "确认");
  await expect(admin.getByTestId(`forum-row-${sectionId}`)).toHaveCount(0);

  await adminCtx.close();
  await guest.context().close();
});
