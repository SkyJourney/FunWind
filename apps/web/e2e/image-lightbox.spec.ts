import { expect, test } from "@playwright/test";
import { USERS, loginAs } from "./support/session";

/**
 * 图片点击放大 E2E（M10.6d）：帖子内容图 → YAR lightbox（单实例）→ 缩放工具/关闭/遮罩/Esc 全交互。
 * 帖 2824（玉子爱情故事）含 1 张内容图 + 表情小图（表情不触发放大）。
 */
test.describe.configure({ mode: "serial" });

test("图片放大：点击打开单实例 → 关闭按钮 → Esc → 遮罩点击 全交互", async ({ page }) => {
  await loginAs(page.context(), USERS.admin);
  await page.goto("/t/950002"); // E2E 夹具：正文含 /files/ 图的可见帖
  await expect(page.locator(".content-md img").first()).toBeVisible();

  const yarl = page.locator('[class*="yarl__container"]');

  // 内容图点击 → 恰好一个 lightbox（表情不触发由选择器排除保证）
  await page.locator('.content-md img:not([src*="/emoji/"])').first().click();
  await expect(yarl).toHaveCount(1);
  await expect(page.locator('button[aria-label="Close"]')).toBeVisible();

  // 缩放工具条存在（Zoom 插件：放大/缩小/倍率重置）
  await expect(page.locator('button[aria-label="Zoom in"]')).toBeVisible();

  // 关闭按钮 → 容器卸载（回归断言：站长实测「关闭后图仍停留」的多实例叠加 bug）
  await page.locator('button[aria-label="Close"]').click();
  await expect(yarl).toHaveCount(0);

  // 重开 → Esc 关闭（YAR 自带键盘处理，需真实焦点在文档上）
  await page.locator('.content-md img:not([src*="/emoji/"])').first().click();
  await expect(yarl).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(yarl).toHaveCount(0);

  // 重开 → 遮罩点击关闭（点 lightbox 容器边缘的非图片区）
  await page.locator('.content-md img:not([src*="/emoji/"])').first().click();
  await expect(yarl).toHaveCount(1);
  await page.mouse.click(10, 400); // 视口左缘=遮罩区
  await expect(yarl).toHaveCount(0);
});
