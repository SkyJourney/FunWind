import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * 主题装饰素材池（M11.1 Step 4）：admin 上传 → 入池设当前 → /brand/decor 公开输出 200；
 * 像素超限（3841 宽 > 3840 上限）被拒并回显 oversize 文案、不入池；
 * 移除 → 池空、/brand/decor 404（像素上限矩阵见 decor-pool.int.test）。
 * 自愈：afterAll 清 site.decor 池；磁盘文件由 E2E 存储目录生命周期兜底（prepare 脚本重置）。
 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

test.afterAll(() =>
  withE2eDb((q) => q.exec("DELETE FROM site_settings WHERE `key` = 'site.decor'")),
);

test("admin：像素超限被拒 → 合法素材上传入池 → /brand/decor 可访问 → 移除后 404", async ({
  page,
  request,
}) => {
  await loginAs(page.context(), USERS.admin);
  await page.goto("/admin/decor");

  // 超尺寸：3841×100 超过 3840×2160 上限 → ?err=oversize 文案回显，不入池
  await page.getByLabel(/名称/).fill("E2E 太宽底纹");
  await page.getByLabel(/PNG 文件/).setInputFiles({
    name: "wide.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 3841, height: 100, channels: 3, background: "#8b7d6b" },
    })
      .png()
      .toBuffer(),
  });
  await page.getByRole("button", { name: "上传入池" }).click();
  await page.waitForURL("**/admin/decor?err=oversize");
  await expect(page.getByText(/像素超过 3840×2160/)).toBeVisible();

  // 合法底纹入池设当前 → 公开输出 200
  await page.getByLabel(/名称/).fill("E2E 纸纹底");
  await page.getByLabel(/PNG 文件/).setInputFiles({
    name: "paper.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 1200, height: 800, channels: 3, background: "#efe7d0" },
    })
      .png()
      .toBuffer(),
  });
  await page.getByRole("button", { name: "上传入池" }).click();
  await page.waitForURL("**/admin/decor?added=*");
  await expect(page.getByText("已入池并设为当前")).toBeVisible();
  expect((await request.get("/brand/decor")).status()).toBe(200);

  // 移除 → 池空、公开输出 404
  await page.getByRole("button", { name: "移除" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await page.waitForURL("**/admin/decor");
  await expect(page.getByText("池还是空的")).toBeVisible();
  expect((await request.get("/brand/decor")).status()).toBe(404);
});
