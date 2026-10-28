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
  await page.locator('input[type="file"][aria-label="选择图片"]').setInputFiles({
    name: "图.png",
    mimeType: "image/png",
    buffer: PNG_1X1,
  });
  // 图片以图片节点出现在编辑器里
  await expect(bodyEditor(page).locator("img:not(.ProseMirror-separator)")).toBeVisible();
  await page.getByRole("button", { name: "发布主题" }).click();
  await expect(page).toHaveURL(/\/t\/\d+$/);
  await expect(page.locator('.content-md img[src^="/files/"]').first()).toBeVisible();
});

test("会员：工具栏上传图片 → 附件面板出现「正文图片」；移除条目删掉正文图；已传图片附件可「插入正文」", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.member);
  await page.goto(`/f/${FIX.compose.id}/new`);
  await page.locator("#thread-title").fill(`E2E 联动 ${Date.now()}`);
  await fillBody(page, "联动前言");

  // 工具栏图片按钮 → 文件选择器 → 上传并插入
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传图片" }).click();
  await (await chooser).setFiles({ name: "图.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(bodyEditor(page).locator("img:not(.ProseMirror-separator)")).toHaveCount(1);
  const row = page.getByTestId("inline-image-row");
  await expect(row).toHaveCount(1);
  // 缩略图是真实可加载的 /files 图
  await expect(row.locator("img")).toHaveAttribute("src", /^\/files\//);

  // 移除条目 = 删正文引用
  await page.getByRole("button", { name: "移除正文图片：图片 1" }).click();
  await expect(bodyEditor(page).locator("img:not(.ProseMirror-separator)")).toHaveCount(0);
  await expect(row).toHaveCount(0);

  // 先作为附件上传，再「插入正文」：转入正文图片组，不再留在下载附件里
  await page
    .locator('input[type="file"][aria-label="选择附件"]')
    .setInputFiles({ name: "封面.png", mimeType: "image/png", buffer: PNG_1X1 });
  const att = page.getByTestId("attachment-row").filter({ hasText: "封面.png" });
  await expect(att).toBeVisible();
  await page.getByRole("button", { name: "插入正文：封面.png" }).click();
  await expect(bodyEditor(page).locator("img:not(.ProseMirror-separator)")).toHaveCount(1);
  await expect(row).toHaveCount(1);
  await expect(att).toHaveCount(0);

  // 发布：正文图可见，且不会作为下载附件重复出现
  await page.getByRole("button", { name: "发布主题" }).click();
  await expect(page).toHaveURL(/\/t\/\d+$/);
  await expect(page.locator('.content-md img[src^="/files/"]').first()).toBeVisible();
  await expect(page.getByText("封面.png")).toHaveCount(0);
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
  // 本用例经 fillSource 停留在源码模式：此处的入口是编辑区下方的勾选框（所见即所得模式下是工具栏开关，见单测）
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

test("头像：选图、强制正方形裁剪、保存后页面显示新头像（/files/ 地址）", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.member);
  await page.goto("/settings/avatar");
  await page.locator('input[type="file"][aria-label="选择头像图片"]').setInputFiles({
    name: "头像.png",
    mimeType: "image/png",
    buffer: await solidPng(200),
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("头像需为正方形")).toBeVisible();
  await dialog.getByRole("button", { name: "保存头像" }).click();
  await expect(page.getByRole("status")).toHaveText("头像已更新。");
  await expect(page.getByRole("img", { name: /的当前头像/ })).toHaveAttribute(
    "src",
    /^\/files\/.+\.webp$/,
  );
});
