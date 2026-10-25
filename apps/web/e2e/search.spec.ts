import { expect, test } from "@playwright/test";
import { USERS, loginAs } from "./support/session";

/**
 * 搜索 E2E（M8 S7）：中日文词表（seed 稳定词：青翼=标题、刀剣乱舞=正文）；
 * 「字幕组」仅受限版块可见 → team 用户命中、游客零命中；空结果引导。
 */

test.describe.configure({ mode: "serial" });

test("游客：搜索「青翼」命中主题；「刀剣乱舞」正文命中", async ({ page }) => {
  await page.goto("/search?q=%E9%9D%92%E7%BF%BC"); // 青翼
  await expect(page.getByText(/「青翼」共 \d+ 个主题/)).toBeVisible();
  await expect(page.getByRole("link", { name: /欢迎来到新青翼/ })).toBeVisible();

  await page.goto("/search?q=%E5%88%80%E5%89%A3%E4%B9%B1%E8%88%9E"); // 刀剣乱舞
  await expect(page.getByText(/「刀剣乱舞」共 \d+ 个主题/)).toBeVisible();
});

test("可见性：游客搜「字幕组」相关受限词零命中；team 命中受限版块内容", async ({
  page,
  context,
}) => {
  // 「字幕分工」只出现在受限版块 904 的 900005
  await page.goto("/search?q=%E5%AD%97%E5%B9%95%E5%88%86%E5%B7%A5"); // 字幕分工
  await expect(page.getByText("没有找到与「字幕分工」相关的内容")).toBeVisible();
  await expect(page.getByRole("link", { name: /内部/ })).toHaveCount(0);

  await loginAs(context, USERS.team);
  await page.goto("/search?q=%E5%AD%97%E5%B9%95%E5%88%86%E5%B7%A5");
  await expect(page.getByRole("link", { name: /\[内部\] 本季度字幕分工表/ })).toBeVisible();
});

test("空态引导与排序切换", async ({ page }) => {
  await page.goto("/search?q=zzz%E4%B8%8D%E5%AD%98%E5%9C%A8zzz");
  await expect(page.getByText(/没有找到与/)).toBeVisible();

  await page.goto("/search?q=%E9%9D%92%E7%BF%BC&sort=time");
  await expect(page.getByText(/按相关度排序/)).toBeVisible();
  await page.getByRole("link", { name: "按相关度排序" }).click();
  await expect(page).toHaveURL(/sort=relevance/);
});
