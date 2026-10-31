import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * 首页 Hero 横幅（M11 插槽 ⑤）：admin 上传 → 入池设当前 → 首页渲染 /brand/hero；
 * 像素超限（1921 宽 > 1920 上限）被拒并回显 oversize 文案、不入池；
 * 移除 → 首页不占位、/brand/hero 404（像素上限矩阵见 hero-pool.int.test）。
 * 自愈：afterAll 清 site.hero 池；磁盘文件由 E2E 存储目录生命周期兜底（prepare 脚本重置）。
 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

test.afterAll(() =>
  withE2eDb((q) => q.exec("DELETE FROM site_settings WHERE `key` = 'site.hero'")),
);

test("admin：像素超限被拒 → 合法横幅上传入池 → 首页渲染 → 移除后不占位、路由 404", async ({
  page,
  request,
}) => {
  await loginAs(page.context(), USERS.admin);
  await page.goto("/admin/hero");

  // 超尺寸：1921×100 超过 1920×1080 上限 → ?err=oversize 文案回显，不入池
  await page.getByLabel(/名称/).fill("E2E 太宽横幅");
  await page.getByLabel(/PNG 文件/).setInputFiles({
    name: "wide.png",
    mimeType: "image/png",
    buffer: await sharp({ create: { width: 1921, height: 100, channels: 3, background: "#369" } })
      .png()
      .toBuffer(),
  });
  await page.getByRole("button", { name: "上传入池" }).click();
  await page.waitForURL("**/admin/hero?err=oversize");
  await expect(page.getByText(/像素超过 1920×1080/)).toBeVisible();

  // 合法横幅：入池设当前（高亮提示）
  await page.getByLabel(/名称/).fill("E2E 活动横幅");
  await page.getByLabel(/PNG 文件/).setInputFiles({
    name: "hero.png",
    mimeType: "image/png",
    buffer: await sharp({ create: { width: 640, height: 200, channels: 3, background: "#336699" } })
      .png()
      .toBuffer(),
  });
  await page.getByRole("button", { name: "上传入池" }).click();
  await page.waitForURL("**/admin/hero?added=*");
  await expect(page.getByText("已入池并设为当前")).toBeVisible();

  // 首页出现 Hero；公开路由 200
  await page.goto("/");
  await expect(page.locator('img[src="/brand/hero"]')).toBeVisible();
  expect((await request.get("/brand/hero")).status()).toBe(200);

  // 移除（确认对话框）→ 首页不再渲染，公开路由 404
  await page.goto("/admin/hero");
  await page.getByRole("button", { name: "移除" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await page.waitForURL("**/admin/hero");
  await expect(page.getByText("池还是空的")).toBeVisible();

  await page.goto("/");
  await expect(page.locator('img[src="/brand/hero"]')).toHaveCount(0);
  expect((await request.get("/brand/hero")).status()).toBe(404);
});
