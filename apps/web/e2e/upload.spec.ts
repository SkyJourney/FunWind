import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { PNG_1X1, solidPng, txtAttachment } from "./support/images";
import { bodyEditor, fillBody, fillSource } from "./support/editor";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";

/**
 * 上传 E2E（M6.4d2，桌面）：正文插图、附件的门控归属与泄露检查、裁剪后插入。
 * 发帖间隔用 relaxPostInterval 临时放宽（每个用例都会发帖）；会员的每日上传额度（20）足够本文件的次数。
 */

test.describe.configure({ mode: "serial" });

let restoreLimits: () => Promise<void>;

test.beforeAll(async () => {
  restoreLimits = await relaxPostInterval();
});
test.afterAll(async () => {
  await restoreLimits();
});

test("会员：正文插入图片，发布后主题页的正文图片指向 /files/（内容寻址地址）", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.member);
  await page.goto(`/f/${FIX.compose.id}/new`);
  await page.locator("#thread-title").fill(`E2E 插图 ${Date.now()}`);
  // 富文本模式（fillSource 会切到源码，图片就只是 Markdown 文本）
  await fillBody(page, "正文前言");
  await page.getByRole("button", { name: "插入图片" }).click();
  await page.locator('input[type="file"][aria-label="选择图片"]').setInputFiles({
    name: "图.png",
    mimeType: "image/png",
    buffer: PNG_1X1,
  });
  // 图片以图片节点出现在编辑器里
  await expect(bodyEditor(page).locator("img")).toBeVisible();
  await page.getByRole("button", { name: "发布主题" }).click();
  await expect(page).toHaveURL(/\/t\/\d+$/);
  await expect(page.locator('.content-md img[src^="/files/"]').first()).toBeVisible();
});

test("会员：附件归属门控后，游客只看到锁定提示，看不到文件名；作者看到文件名", async ({
  page,
  context,
  browser,
}) => {
  const title = `E2E 门控附件 ${Date.now()}`;
  await loginAs(context, USERS.member);
  await page.goto(`/f/${FIX.compose.id}/new`);
  await page.locator("#thread-title").fill(title);
  await fillSource(page, `公开前言\n\n:::gate{key="g1" unlock="points" price="10"}\n门控正文\n:::`);
  await page
    .locator('input[type="file"][aria-label="选择附件"]')
    .setInputFiles(txtAttachment("E2E-门控附件.txt"));
  const row = page.getByTestId("attachment-row").filter({ hasText: "E2E-门控附件.txt" });
  await expect(row).toBeVisible();
  await row.getByRole("combobox").selectOption("g1");
  await page.getByRole("button", { name: "发布主题" }).click();
  await expect(page).toHaveURL(/\/t\/\d+$/);
  const threadPath = new URL(page.url()).pathname;

  // 游客：只看到锁定数量，文件名不出现在页面里
  const guest = await browser.newContext();
  const gp = await guest.newPage();
  await gp.goto(threadPath);
  await expect(gp.getByTestId("locked-attachments")).toBeVisible();
  await expect(gp.getByText("E2E-门控附件.txt")).toHaveCount(0);
  await guest.close();

  // 作者：看到文件名
  await expect(page.getByText("E2E-门控附件.txt")).toBeVisible();
});

test("裁剪后插入：勾选裁剪，确认裁剪框后图片插入正文", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  await page.goto(`/f/${FIX.compose.id}/new`);
  await page.locator("#thread-title").fill(`E2E 裁剪 ${Date.now()}`);
  await fillSource(page, "裁剪前言");
  await page.getByRole("checkbox", { name: "裁剪后插入" }).check();
  // 裁剪的最小边长是 32 像素：用 96×96 的图（1×1 的图无法框出合法的裁剪区域）
  await page.locator('input[type="file"][aria-label="选择图片"]').setInputFiles({
    name: "裁剪.png",
    mimeType: "image/png",
    buffer: await solidPng(96),
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("裁剪图片")).toBeVisible();
  await dialog.getByRole("button", { name: "插入图片" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('input[name="source"]')).toHaveValue(/!\[.*\]\(\/files\/.+\)/);
});
