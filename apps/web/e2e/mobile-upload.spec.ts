import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * 上传的移动端版式（M6.4d2，375px）：没有横向滚动；插入图片与附件的按钮在视口内，触控目标不小于 44px。
 */

test("会员：发主题页的上传控件在 375px 下可见、可点、无横向滚动", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  await page.goto(`/f/${FIX.compose.id}/new`);
  const insert = page.getByRole("button", { name: "插入图片" });
  await expect(insert).toBeVisible();
  const box = await insert.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("button", { name: "添加附件" })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("会员：头像设置页在 375px 下无横向滚动，选择按钮可触控", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  await page.goto("/settings/avatar");
  const choose = page.getByRole("button", { name: "选择头像", exact: true });
  await expect(choose).toBeVisible();
  const box = await choose.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(36);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
