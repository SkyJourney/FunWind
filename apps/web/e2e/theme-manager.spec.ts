import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/** M11.1 Step 5：后台创建与编辑数据主题包，并验证草稿预览和表单提交。 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

const THEME_ID = `e2e-theme-${Date.now().toString(36)}`;

async function cleanup() {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM theme_packages WHERE id LIKE ?", [`${THEME_ID}%`]);
    await q.exec("UPDATE user_profiles SET theme_pack = NULL WHERE user_id = ?", [USERS.admin]);
    await q.exec(
      "DELETE FROM site_settings WHERE `key` IN ('site.decor', 'site.theme', 'site.logo')",
    );
    await q.exec("UPDATE user_profiles SET theme_pack = NULL WHERE user_id = ?", [USERS.member]);
  });
}

test.afterAll(cleanup);

test("会员访问主题管理 → 404", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  expect((await page.goto("/admin/themes"))?.status()).toBe(404);
});

test("管理员创建并编辑主题包：草稿预览与 definition 同步提交", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  await page.goto("/admin/decor");
  await page.getByLabel(/名称/).fill("E2E 主题包资源");
  await page.getByLabel(/PNG 文件/).setInputFiles({
    name: "theme-decor.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 640, height: 360, channels: 3, background: "#d8c8a8" },
    })
      .png()
      .toBuffer(),
  });
  await page.getByRole("button", { name: "上传入池" }).click();
  await page.waitForURL("**/admin/decor?added=*");
  const decorFile = new URL(page.url()).searchParams.get("added")!;
  expect(decorFile).toMatch(/^decor-[a-f0-9]{32}\.png$/);

  await page.goto("/admin/themes");
  await page.getByLabel("包 id", { exact: true }).fill(THEME_ID);
  await page.getByLabel("名称").fill("E2E 自定义主题");
  await page.getByLabel("说明").fill("主题管理完整流程验证");
  await page.getByRole("button", { name: "新建主题包" }).click();
  await expect(page).toHaveURL(new RegExp(`saved=created&id=${THEME_ID}`));

  await page.locator(`a[href="/admin/themes/${THEME_ID}"]`).click();
  await expect(page.getByRole("heading", { name: `编辑主题包 · E2E 自定义主题` })).toBeVisible();
  await page.getByRole("button", { name: "深色档" }).click();
  await expect(page.getByTestId("theme-preview")).toHaveAttribute("data-mode", "dark");
  await page.getByTestId("theme-fill-solid-color").fill("#334455");
  await page.getByLabel("浏览器主题色").fill("#123456");
  await page.getByRole("button", { name: "浅色档" }).click();
  await page.getByRole("button", { name: "公告横幅", exact: true }).click();
  await page.getByRole("radio", { name: "线性渐变" }).check();
  const angle = page.locator('input[type="range"]');
  await angle.focus();
  await angle.press("End");
  await page.getByRole("button", { name: "添加色标" }).click();
  await page.getByRole("button", { name: "删除填充色标 3" }).click();
  await page.getByRole("button", { name: "板块卡底纹", exact: true }).click();
  await page.getByRole("radio", { name: "图片底纹" }).check();
  await page.getByLabel("填充素材").selectOption(decorFile);
  await page.getByRole("button", { name: "全局页面背景", exact: true }).click();
  await page.getByTestId("theme-fill-solid-color").fill("#f8f5e8");
  await page.getByRole("button", { name: "公告横幅", exact: true }).click();

  const definitionInput = page.locator('input[name="definition"]');
  await expect
    .poll(async () => {
      const definition = JSON.parse(await definitionInput.inputValue()) as {
        surfaces: Record<
          string,
          {
            light?: { fill?: { angle?: number; asset?: string } };
            dark?: { fill?: { color?: string } };
          }
        >;
      };
      return definition.surfaces["banner-announce"]?.light?.fill?.angle;
    })
    .toBe(359);
  await expect(page.getByTestId("theme-preview")).toHaveAttribute(
    "data-surface",
    "banner-announce",
  );
  await expect(page.getByTestId("theme-preview")).toHaveAttribute(
    "style",
    /--sf-banner-announce-bg: linear-gradient\(359deg/,
  );

  await page.getByRole("button", { name: "保存主题包" }).click();
  await expect(page).toHaveURL(`/admin/themes/${THEME_ID}?saved=1`);
  await expect(page.getByText("主题包配置已保存。")).toBeVisible();
  const stored = await withE2eDb((q) =>
    q.query<{
      revision: number;
      definition: {
        pwa?: { themeColor?: string; backgroundColor?: string };
        surfaces: Record<
          string,
          {
            light?: { fill?: { angle?: number; asset?: string } };
            dark?: { fill?: { color?: string } };
          }
        >;
      };
      assets: Array<{ kind: "decor" | "logo"; poolFile: string }>;
    }>("SELECT revision, definition, assets FROM theme_packages WHERE id = ?", [THEME_ID]),
  );
  expect(stored[0]?.revision).toBe(2);
  expect(stored[0]?.definition.surfaces.header?.dark?.fill?.color).toBe("#334455");
  expect(stored[0]?.definition.surfaces["banner-announce"]?.light?.fill?.angle).toBe(359);
  expect(stored[0]?.definition.surfaces["forum-band"]?.light?.fill?.asset).toBe(decorFile);
  expect(stored[0]?.assets).toContainEqual({ kind: "decor", poolFile: decorFile });

  await page.goto("/");
  await page.getByRole("button", { name: "主题切换" }).click();
  const themePatch = page.waitForResponse(
    (response) =>
      response.url().includes("/api/settings/preferences") &&
      response.request().method() === "PATCH",
  );
  await page.locator(`[data-pack-option="${THEME_ID}"]`).click();
  await expect(page.locator("html")).toHaveAttribute("data-pack", THEME_ID);
  expect((await themePatch).status()).toBe(200);
  const pageSurfaceColor = await page
    .locator('body[data-surface="page"]')
    .evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
  expect(pageSurfaceColor).toBe("rgb(248, 245, 232)");
  const headerSurfaceColor = await page
    .locator('header[data-surface="header"]')
    .evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
  expect(headerSurfaceColor).toBe("rgb(248, 250, 252)");

  await page.goto("/admin/themes");
  const originalCard = page
    .locator("div.rounded-xl.border.bg-card")
    .filter({ has: page.locator(`a[href="/admin/themes/${THEME_ID}"]`) });
  await originalCard.getByRole("button", { name: "设为默认" }).click();
  await expect(page).toHaveURL(/saved=default/);
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(await manifest.json()).toMatchObject({ theme_color: "#123456" });
  await page
    .locator("div.rounded-xl.border.bg-card")
    .filter({ has: page.locator('a[href="/admin/themes/default"]') })
    .getByRole("button", { name: "设为默认" })
    .click();
  await expect(page).toHaveURL(/saved=default/);

  const downloadPromise = page.waitForEvent("download");
  await originalCard.getByRole("link", { name: "导出 ZIP" }).click();
  const download = await downloadPromise;
  const archivePath = await download.path();
  expect(archivePath).not.toBeNull();
  const archiveBytes = await readFile(archivePath!);
  const rejectedId = `${THEME_ID}-bad`;
  await page.getByLabel("新包 id").fill(rejectedId);
  await page.getByLabel("主题包 ZIP 文件").setInputFiles({
    name: "broken.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("not a zip archive"),
  });
  await page.getByRole("button", { name: "导入主题包" }).click();
  await page.waitForURL(/err=bad-archive/);
  await expect(page.getByText("主题包文件损坏、版本不支持或包含不安全内容。")).toBeVisible();
  const rejected = await withE2eDb((q) =>
    q.query<{ id: string }>("SELECT id FROM theme_packages WHERE id = ?", [rejectedId]),
  );
  expect(rejected).toHaveLength(0);

  await page.goto("/admin/themes");
  const importedId = `${THEME_ID}-import`;
  await page.getByLabel("新包 id").fill(importedId);
  await page.getByLabel("主题包 ZIP 文件").setInputFiles({
    name: "theme.zip",
    mimeType: "application/zip",
    buffer: archiveBytes,
  });
  await page.getByRole("button", { name: "导入主题包" }).click();
  await expect(page).toHaveURL(new RegExp(`saved=imported&id=${importedId}`));
  const imported = await withE2eDb((q) =>
    q.query<{
      revision: number;
      definition: {
        pwa?: { themeColor?: string; backgroundColor?: string };
        surfaces: Record<
          string,
          {
            light?: { fill?: { angle?: number; asset?: string } };
            dark?: { fill?: { color?: string } };
          }
        >;
      };
      assets: Array<{ kind: "decor" | "logo"; poolFile: string }>;
    }>("SELECT revision, definition, assets FROM theme_packages WHERE id = ?", [importedId]),
  );
  expect(imported[0]?.revision).toBe(1);
  expect(imported[0]?.definition.surfaces.header?.dark?.fill?.color).toBe("#334455");
  expect(imported[0]?.definition.surfaces["banner-announce"]?.light?.fill?.angle).toBe(359);
  expect(imported[0]?.definition.pwa).toMatchObject({ themeColor: "#123456" });
  const importedDecorFile =
    imported[0]?.definition.surfaces["forum-band"]?.light?.fill?.asset ?? "";
  expect(importedDecorFile).toMatch(/^decor-[a-f0-9]{32}\.png$/);
  expect(importedDecorFile).not.toBe(decorFile);
  expect(imported[0]?.assets).toContainEqual({ kind: "decor", poolFile: importedDecorFile });
  expect(
    (
      await page.request.get(`/brand/decor?file=${encodeURIComponent(importedDecorFile!)}`)
    ).status(),
  ).toBe(200);

  await page.goto("/admin/decor");
  const decorCard = page.locator("div.rounded-xl.border.bg-card").filter({ hasText: decorFile });
  await decorCard.getByRole("button", { name: "移除" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page).toHaveURL(/err=in-use/);
  await expect(
    page.getByText("素材仍被主题包引用，不能移除；请先在主题包中解除引用。"),
  ).toBeVisible();

  await page.goto("/admin/themes");
  const sourceCard = page
    .locator("div.rounded-xl.border.bg-card")
    .filter({ has: page.locator(`a[href="/admin/themes/${THEME_ID}"]`) });
  await sourceCard.getByRole("button", { name: "复制" }).click();
  await expect(page).toHaveURL(/saved=copied&id=/);
  const copies = await withE2eDb((q) =>
    q.query<{ id: string }>("SELECT id FROM theme_packages WHERE id LIKE ?", [
      `${THEME_ID}-copy-%`,
    ]),
  );
  expect(copies).toHaveLength(1);

  const copyId = copies[0]!.id;
  const copyCard = page
    .locator("div.rounded-xl.border.bg-card")
    .filter({ has: page.locator(`a[href="/admin/themes/${copyId}"]`) });
  await copyCard.getByRole("button", { name: "停用" }).click();
  await expect(page).toHaveURL(/saved=toggled/);
  const [disabledCopy] = await withE2eDb((q) =>
    q.query<{ enabled: number }>("SELECT enabled FROM theme_packages WHERE id = ?", [copyId]),
  );
  expect(disabledCopy?.enabled).toBe(0);

  await page
    .locator("div.rounded-xl.border.bg-card")
    .filter({ has: page.locator(`a[href="/admin/themes/${copyId}"]`) })
    .getByRole("button", { name: "删除" })
    .click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page).toHaveURL(/saved=deleted/);
  const deleted = await withE2eDb((q) =>
    q.query<{ id: string }>("SELECT id FROM theme_packages WHERE id = ?", [copyId]),
  );
  expect(deleted).toHaveLength(0);
});

test("主题管理后台入口可见；编辑区内嵌素材库可上传并选用；草稿预览不落库", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await page.goto("/admin/themes");
  // 后台「站点管理」分组里有「主题管理」入口
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link", { name: "主题管理" })).toBeVisible();

  await page.goto(`/admin/themes/${THEME_ID}`);
  const library = page.getByTestId("theme-asset-library");
  await expect(library).toBeVisible();

  // 工作区内上传素材 → 出现在素材库网格
  const beforeCount = await library.locator("li").count();
  await library.getByLabel(/上传 PNG 素材/).setInputFiles({
    name: "workspace-decor.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 320, height: 200, channels: 3, background: "#b8c4a0" },
    })
      .png()
      .toBuffer(),
  });
  await expect
    .poll(async () => library.locator("li").count(), { timeout: 10_000 })
    .toBe(beforeCount + 1);

  // 选用为当前区域底纹 → 写入草稿（此时库里 revision 不变）
  await page.getByRole("button", { name: "板块卡底纹", exact: true }).click();
  const useFill = library.getByRole("button", { name: /用作.*底纹/ }).first();
  await useFill.click();
  const definitionInput = page.locator('input[name="definition"]');
  await expect
    .poll(async () => {
      const definition = JSON.parse(await definitionInput.inputValue()) as {
        surfaces: Record<string, { light?: { fill?: { asset?: string } } }>;
      };
      return definition.surfaces["forum-band"]?.light?.fill?.asset;
    })
    .toMatch(/^decor-[a-f0-9]{32}\.png$/);

  // 预览里的图片真实加载（不再是破图）：naturalWidth > 0 才算取到
  const previewImage = page.getByTestId("theme-preview-image");
  await expect(previewImage).toBeVisible();
  await expect
    .poll(async () => previewImage.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  // 草稿不落库：库内 revision 仍是 2（此前保存过一次）
  const [beforeSave] = await withE2eDb((q) =>
    q.query<{ revision: number }>("SELECT revision FROM theme_packages WHERE id = ?", [THEME_ID]),
  );
  expect(beforeSave?.revision).toBe(2);

  // 保存后 revision +1 且引用写入
  await page.getByRole("button", { name: "保存主题包" }).click();
  await expect(page).toHaveURL(`/admin/themes/${THEME_ID}?saved=1`);
  const [afterSave] = await withE2eDb((q) =>
    q.query<{ revision: number }>("SELECT revision FROM theme_packages WHERE id = ?", [THEME_ID]),
  );
  expect(afterSave?.revision).toBe(3);
});

test("素材引用徽标可见；被引用素材在素材库不可移除", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  await page.goto("/admin/decor");
  const referenced = page.locator("li, div").filter({ hasText: "被 1 个主题引用" }).first();
  await expect(referenced).toBeVisible();
});

test("全站预览：进入后整站按该包渲染，可退出恢复", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  await page.goto(`/admin/themes/${THEME_ID}`);
  await page.getByRole("button", { name: "全站预览此主题" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/themes/${THEME_ID}\\?preview=1`));

  await page.goto("/");
  await expect(page.getByTestId("theme-preview-banner")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-pack", THEME_ID);

  await page.getByRole("button", { name: "退出预览" }).click();
  await page.waitForURL("**/admin/themes");
  await page.goto("/");
  await expect(page.getByTestId("theme-preview-banner")).toHaveCount(0);
});

test("停用用户已选中的包 → 前台回退默认主题", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  await page.goto("/");
  await page.getByRole("button", { name: "主题切换" }).click();
  await page.locator(`[data-pack-option="${THEME_ID}"]`).click();
  await expect(page.locator("html")).toHaveAttribute("data-pack", THEME_ID);

  const adminContext = await context.browser().newContext();
  try {
    await loginAs(adminContext, USERS.admin);
    const adminPage = await adminContext.newPage();
    await adminPage.goto("/admin/themes");
    const card = adminPage
      .locator("div.rounded-xl.border.bg-card")
      .filter({ has: adminPage.locator(`a[href="/admin/themes/${THEME_ID}"]`) });
    await card.getByRole("button", { name: "停用" }).click();
    await expect(adminPage).toHaveURL(/saved=toggled/);
  } finally {
    await adminContext.close();
  }

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-pack", "default");
});

test("保存冲突不丢草稿（G-19 实证）：本地档恢复工作成果，重试保存成功", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await page.goto(`/admin/themes/${THEME_ID}`);
  await expect(page.getByRole("heading", { name: /编辑主题包 · E2E 自定义主题/ })).toBeVisible();

  // 改草稿：header 深色档颜色改为可识别值，并等隐藏 definition 同步（与既有用例同口径）
  await page.getByRole("button", { name: "深色档" }).click();
  await expect(page.getByTestId("theme-preview")).toHaveAttribute("data-mode", "dark");
  await page.getByTestId("theme-fill-solid-color").fill("#1a2b3c");
  const definitionInput = page.locator('input[name="definition"]');
  await expect
    .poll(
      async () => JSON.parse(await definitionInput.inputValue()).surfaces.header?.dark?.fill?.color,
    )
    .toBe("#1a2b3c");

  // 模拟并发保存：持锁页面的 revision 已过期后再提交 → conflict。
  // G-19 实证结论：冲突 redirect 是软导航（window 存活）但编辑器子树仍被新 RSC 树
  // 整体重挂载，纯内存草稿全丢——故编辑器草稿随写 sessionStorage、带 err 重挂载时恢复。
  await withE2eDb((q) =>
    q.exec("UPDATE theme_packages SET revision = revision + 1 WHERE id = ?", [THEME_ID]),
  );
  await page.getByRole("button", { name: "保存主题包" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/themes/${THEME_ID}\\?err=conflict`));
  await expect(page.getByText("版本冲突", { exact: false })).toBeVisible();

  // 草稿经本地档恢复：重挂载后编辑器视图回到浅色档默认位，但隐藏 definition
  // 必须带回用户改动（这是提交给服务端的实际负载，工作成果以它为准）
  await expect
    .poll(
      async () => JSON.parse(await definitionInput.inputValue()).surfaces.header?.dark?.fill?.color,
    )
    .toBe("#1a2b3c");

  // 闭环：冲突页由服务端新树渲染（revision 已刷新为库内最新），直接再点保存即可
  // 成功，无需刷新页面——草稿落库，乐观锁恢复正常
  await page.getByRole("button", { name: "保存主题包" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/themes/${THEME_ID}\\?saved=1`));
  const [saved] = await withE2eDb((q) =>
    q.query<{ revision: number; definition: unknown }>(
      "SELECT revision, definition FROM theme_packages WHERE id = ?",
      [THEME_ID],
    ),
  );
  expect(saved?.revision).toBe(6);
  // mysql2 对 JSON 列自动反序列化，兼容两种形态
  const savedDefinition =
    typeof saved!.definition === "string" ? JSON.parse(saved!.definition) : saved!.definition;
  expect(savedDefinition.surfaces.header?.dark?.fill?.color).toBe("#1a2b3c");
});
