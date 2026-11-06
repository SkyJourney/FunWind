import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * M11.6 Step 3h：语义令牌在真浏览器里走完整条线（G-16：成功路径与错误路径成对）。
 * 一个自建的主题包，串行走完：保存令牌 → 全站预览读到新主色 → 非法色值 → 保存冲突 → 导出再导入 → 越权。
 * 单元与集成测试各管一段（预览、对比度、归档往返）；这里验的是它们接在一起之后，真实页面上看得到的结果。
 * 建包、保存都走真实界面，所以目录缓存是被真实动作失效的；清理直接删库。
 */
test.describe.configure({ mode: "serial" });
failOnPageErrors();

const PACK = `e2e-token-${Date.now().toString(36)}`;
const IMPORTED = `${PACK}-imp`;
const UNAUTHORIZED_ID = `${PACK}-no`;
/** 第一次保存的主色 */
const FIRST = "#c0392b";
/** 冲突用例里，本页没保存的主色 */
const DRAFT = "#1abc9c";
/** 冲突用例里，另一个页面保存的主色 */
const OTHER = "#8e44ad";

type Stored = {
  revision: number;
  definition: { tokens?: { light?: { colors?: Record<string, string> } } };
};

async function readStored(id = PACK): Promise<Stored> {
  const [row] = await withE2eDb((q) =>
    q.query<Stored>("SELECT revision, definition FROM theme_packages WHERE id = ?", [id]),
  );
  return row!;
}

const primaryOf = (row: Stored) => row.definition.tokens?.light?.colors?.primary;

test.afterAll(async () => {
  await withE2eDb((q) => q.exec("DELETE FROM theme_packages WHERE id LIKE ?", [`${PACK}%`]));
});

/** 保存按钮在水合之后才可用：用它判断页面已经可以交互 */
async function openEditor(page: Page, options: { tokens?: boolean } = {}) {
  await page.goto(`/admin/themes/${PACK}`);
  await expect(page.getByRole("button", { name: "保存主题包" })).toBeEnabled();
  if (options.tokens !== false) {
    await page.getByTestId("theme-token-editor").locator("summary").click();
  }
}

const primaryField = (page: Page) =>
  page.getByRole("textbox", { name: "主色（全站）", exact: true });

/** 草稿里（隐藏的 definition 字段）当前的浅色主色 */
async function draftPrimary(page: Page): Promise<string | undefined> {
  const raw = await page.locator('input[name="definition"]').inputValue();
  return (JSON.parse(raw) as Stored["definition"]).tokens?.light?.colors?.primary;
}

const isSaved = (url: URL) =>
  url.pathname === `/admin/themes/${PACK}` && url.searchParams.get("saved") === "1";

/** 站点首页上，浅色档下当前生效的 --primary */
async function sitePrimary(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-pack", PACK);
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
  );
}

test("保存令牌后站点立即生效：全站预览读到保存的主色，而不是缓存里保存之前的版本", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await loginAs(context, USERS.admin);
  await page.goto("/admin/themes");
  await page.getByLabel("包 id", { exact: true }).fill(PACK);
  await page.getByLabel("名称").fill("E2E 令牌流程");
  await page.getByRole("button", { name: "新建主题包" }).click();
  await expect(page).toHaveURL(new RegExp(`saved=created&id=${PACK}`));

  // 全站预览（不落库、不影响别人）；先读一次没有令牌时站点上的主色，这次请求也让目录缓存装进「保存之前」的版本
  await openEditor(page, { tokens: false });
  await page.getByRole("button", { name: "全站预览此主题" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/themes/${PACK}\\?preview=1`));
  const before = await sitePrimary(page);
  expect(before, "新包没有令牌，主色来自基础层").not.toBe(FIRST);

  await openEditor(page);
  await page.getByRole("button", { name: "主色：覆盖", exact: true }).click();
  await primaryField(page).fill(FIRST);
  await page.getByRole("button", { name: "保存主题包" }).click();
  await expect(page).toHaveURL(isSaved);
  expect(primaryOf(await readStored())).toBe(FIRST);

  // 保存之后第一次请求就要读到新值：目录缓存有 30 秒 TTL，靠保存时失效而不是等它过期
  expect(await sitePrimary(page)).toBe(FIRST);
});

test("输入非法色值：行内提示，预览和草稿仍是上一个合法值，保存的也是它", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await openEditor(page);
  const field = primaryField(page);
  await expect(field).toHaveValue(FIRST);
  const before = await readStored();

  await field.fill("#12");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText(`须为 #RRGGBB（如 #147ba9），当前仍使用 ${FIRST}`)).toBeVisible();
  expect(await draftPrimary(page), "草稿里还是上一个合法值").toBe(FIRST);
  const previewPrimary = await page
    .getByTestId("token-preview")
    .evaluate((el) => (el as HTMLElement).style.getPropertyValue("--primary").trim());
  expect(previewPrimary, "预览里还是上一个合法值").toBe(FIRST);

  await page.getByRole("button", { name: "保存主题包" }).click();
  await expect(page).toHaveURL(isSaved);
  const after = await readStored();
  expect(primaryOf(after), "存进库里的是上一个合法值，不是半截的文本").toBe(FIRST);
  expect(after.revision).toBe(before.revision + 1);
});

test("令牌的保存冲突：别人先保存了，本页提示冲突，令牌草稿和原版本保留；明确载入最新版本后才换成对方的值", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await openEditor(page);
  const revisionInput = page.locator('input[name="revision"]');
  const originalRevision = Number(await revisionInput.inputValue());
  await primaryField(page).fill(DRAFT);
  await expect.poll(() => draftPrimary(page)).toBe(DRAFT);

  // 另一个页面经真实保存动作改了同一个令牌
  const otherPage = await context.newPage();
  try {
    await openEditor(otherPage);
    await primaryField(otherPage).fill(OTHER);
    await otherPage.getByRole("button", { name: "保存主题包" }).click();
    await expect(otherPage).toHaveURL(isSaved);
  } finally {
    await otherPage.close();
  }

  await page.getByRole("button", { name: "保存主题包" }).click();
  await expect(page).toHaveURL(`/admin/themes/${PACK}?err=conflict`);
  const assertDraftKept = async () => {
    await expect.poll(() => draftPrimary(page)).toBe(DRAFT);
    await expect(revisionInput).toHaveValue(String(originalRevision));
    await expect(page.getByRole("button", { name: "保存主题包" })).toBeDisabled();
    await expect(page.getByText(/再次保存不会自动升级版本/)).toBeVisible();
  };
  await assertDraftKept();
  await page.reload();
  await assertDraftKept();

  const concurrent = await readStored();
  expect(concurrent.revision).toBe(originalRevision + 1);
  expect(primaryOf(concurrent), "库里是对方保存的值，没有被本页的草稿覆盖").toBe(OTHER);

  // 取消确认：草稿还在；确认：换成对方的值和最新版本
  const loadLatest = page.getByRole("button", { name: "放弃草稿并载入最新版本" });
  page.once("dialog", (dialog) => dialog.dismiss());
  await loadLatest.click();
  await assertDraftKept();
  page.once("dialog", (dialog) => dialog.accept());
  await loadLatest.click();
  await expect(revisionInput).toHaveValue(String(concurrent.revision));
  await expect.poll(() => draftPrimary(page)).toBe(OTHER);
});

test("导出再导入：新包的令牌与源包逐项相同", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  const source = await readStored();
  expect(primaryOf(source), "源包带着令牌").toBe(OTHER);

  await page.goto("/admin/themes");
  const card = page.locator(`[data-slot="card"]:has(a[href="/admin/themes/${PACK}"])`);
  const download = page.waitForEvent("download");
  await card.getByRole("link", { name: "导出 ZIP" }).click();
  const archive = await readFile((await (await download).path())!);

  await page.goto("/admin/themes");
  await page.getByLabel("新包 id").fill(IMPORTED);
  await page.getByLabel("主题包 ZIP 文件").setInputFiles({
    name: "theme.zip",
    mimeType: "application/zip",
    buffer: archive,
  });
  await page.getByRole("button", { name: "导入主题包" }).click();
  await expect(page).toHaveURL(new RegExp(`saved=imported&id=${IMPORTED}`));

  const imported = await readStored(IMPORTED);
  expect(imported.definition.tokens, "导入的包带着令牌").toEqual(source.definition.tokens);
  expect(primaryOf(imported)).toBe(OTHER);
  expect(imported.definition, "整份定义逐项相同").toEqual(source.definition);
});

test("导出、导入路由的越权：游客跳到登录页，会员 404，库里不多出包", async ({
  context,
  request,
}) => {
  const exportPath = `/admin/themes/${PACK}/export`;
  const multipart = {
    id: UNAUTHORIZED_ID,
    archive: { name: "theme.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip") },
  };
  const toLogin = (response: { status(): number; headers(): Record<string, string> }) => {
    expect(response.status()).toBeGreaterThanOrEqual(300);
    expect(response.status()).toBeLessThan(400);
    expect(new URL(response.headers()["location"]!, "http://127.0.0.1").pathname).toBe("/login");
  };

  // 游客：没有任何登录态的请求上下文
  toLogin(await request.get(exportPath, { maxRedirects: 0 }));
  toLogin(await request.post("/admin/themes/import", { multipart, maxRedirects: 0 }));

  // 会员：和浏览器上下文共用登录态
  await loginAs(context, USERS.member);
  expect((await context.request.get(exportPath, { maxRedirects: 0 })).status()).toBe(404);
  expect(
    (await context.request.post("/admin/themes/import", { multipart, maxRedirects: 0 })).status(),
  ).toBe(404);

  const rows = await withE2eDb((q) =>
    q.query("SELECT id FROM theme_packages WHERE id = ?", [UNAUTHORIZED_ID]),
  );
  expect(rows).toEqual([]);
});
