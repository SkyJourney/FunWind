import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { PNG_1X1 } from "./support/images";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * 主题包偏好与站点默认（M11 Step 2，docs/THEME-SYSTEM.md §2）：
 *   · 外观页表单：自选主题包 → html[data-pack] 服务端直出、刷新与跨页保持；「跟随站点默认」回落；
 *   · 顶栏菜单即时切换：改属性零重载 + PATCH 持久化 → 刷新保持；
 *   · 后台全站默认：保存即生效，游客与未自选用户跟随；改回后复原。
 * qy2010 是 E2E 夹具里的自定义包（2026-11-08 起非内置，与生产同形）；本案只断言 data-pack 值与持久化，不断言视觉。
 * 站点默认是全局状态：本文件串行，且每案结束与 afterAll 都复位（自愈）。
 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

const PACK = FIX.customThemePack;
/** 主题自带 LOGO 用真实定稿图（与生产 qy2010 的站标同一文件） */
const PACK_LOGO = readFileSync(path.resolve(__dirname, "../public/logo/qy2010.png"));

const dataPack = (page: Page) => page.locator("html").getAttribute("data-pack");

const resetAll = () =>
  withE2eDb(async (q) => {
    await q.exec("DELETE FROM site_settings WHERE `key` IN ('site.theme', 'site.logo')");
    await q.exec("UPDATE user_profiles SET theme_pack = NULL WHERE user_id IN (?, ?)", [
      USERS.member,
      USERS.admin,
    ]);
    // LOGO 池清空后，主题绑定的池文件已不存在：一并解绑，回到夹具的「不带素材」状态
    await q.exec("UPDATE theme_packages SET assets = JSON_ARRAY() WHERE id = ?", [PACK.id]);
  });

test.beforeAll(resetAll);
test.afterAll(resetAll);

test("外观页：自选 qy2010 → 直出 data-pack、刷新/跨页保持；跟随站点默认 → 回落 default", async ({
  page,
}) => {
  await loginAs(page.context(), USERS.member);
  await page.goto("/settings/appearance");
  await expect(page.getByRole("heading", { name: "主题包" })).toBeVisible();
  expect(await dataPack(page)).toBe("default");

  await page.getByRole("radio", { name: "复刻·青翼2010" }).check();
  await page.getByRole("button", { name: "保存主题包" }).click();
  await page.waitForURL("**/settings/appearance?saved=1");
  await expect(page.getByText("主题包偏好已保存并即时生效。")).toBeVisible();
  expect(await dataPack(page)).toBe("qy2010");

  await page.reload();
  expect(await dataPack(page)).toBe("qy2010");
  await page.goto("/");
  expect(await dataPack(page)).toBe("qy2010");

  await page.goto("/settings/appearance");
  await expect(page.getByRole("radio", { name: "复刻·青翼2010" })).toBeChecked();
  await page.getByRole("radio", { name: /跟随站点默认/ }).check();
  await page.getByRole("button", { name: "保存主题包" }).click();
  await page.waitForURL("**/settings/appearance?saved=1");
  expect(await dataPack(page)).toBe("default");
});

test("顶栏菜单即时切换：改 data-pack 零重载 + PATCH 持久化 → 刷新保持；切回跟随站点", async ({
  page,
}) => {
  await loginAs(page.context(), USERS.member);
  await page.goto("/");
  expect(await dataPack(page)).toBe("default");

  await page.getByRole("button", { name: "主题切换" }).click();
  const patched = page.waitForResponse(
    (r) => r.url().includes("/api/settings/preferences") && r.request().method() === "PATCH",
  );
  await page.locator('[data-pack-option="qy2010"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-pack", "qy2010");
  expect((await patched).status()).toBe(200);

  await page.reload();
  expect(await dataPack(page)).toBe("qy2010");

  await page.getByRole("button", { name: "主题切换" }).click();
  const patchedBack = page.waitForResponse(
    (r) => r.url().includes("/api/settings/preferences") && r.request().method() === "PATCH",
  );
  await page.locator('[data-pack-option="site"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-pack", "default");
  expect((await patchedBack).status()).toBe(200);
  await page.reload();
  expect(await dataPack(page)).toBe("default");
});

test("后台全站默认：保存即生效 + 主题绑定的 LOGO 联动设为当前；游客跟随；用户自选优先；改回后主题复原而 LOGO 保留（补充关系）", async ({
  browser,
}) => {
  const admin = await browser.newContext();
  const guest = await browser.newContext();
  try {
    await loginAs(admin, USERS.admin);
    const adminPage = await admin.newPage();
    // 起点：LOGO 池为空（resetAll 清过），/brand/logo 404
    expect((await adminPage.request.get("/brand/logo")).status()).toBe(404);

    // qy2010 是自定义包（2026-11-08 起非内置）：它的「自带 LOGO」= 在主题工作区上传并绑定的池文件
    // （内置包的静态自带图分支在生产已无包可达）。上传即入池并设为当前。
    await adminPage.goto(`/admin/themes/${PACK.id}`);
    await adminPage
      .getByLabel("上传 LOGO（PNG ≤512KB）")
      .setInputFiles({ name: "qy2010.png", mimeType: "image/png", buffer: PACK_LOGO });
    await expect(adminPage.getByText("LOGO 已上传并绑定为本主题自带。")).toBeVisible();
    // 再传一枚通用 LOGO 设为当前：之后「设默认主题 → 切回主题自带图」才是一次可观察的切换
    await adminPage.goto("/admin/logo");
    await adminPage.getByLabel("名称").fill("E2E 通用 LOGO");
    await adminPage
      .getByLabel(/^PNG 文件/)
      .setInputFiles({ name: "generic.png", mimeType: "image/png", buffer: PNG_1X1 });
    await adminPage.getByRole("button", { name: "上传入池" }).click();
    const packLogoCard = adminPage
      .locator('[data-slot="card"]:has(input[name="file"])')
      .filter({ hasText: `${PACK.name} 自带` });
    const genericCard = adminPage
      .locator('[data-slot="card"]:has(input[name="file"])')
      .filter({ hasText: "E2E 通用 LOGO" });
    await expect(genericCard).toContainText("当前生效中");
    await expect(packLogoCard).not.toContainText("当前生效中");

    await adminPage.goto("/admin/settings");
    await adminPage.getByRole("radio", { name: new RegExp(PACK.name) }).check();
    await adminPage.getByRole("button", { name: "保存默认主题" }).click();
    // 主题绑定的 LOGO 联动设为当前，flash 走 theme_logo 分支
    await adminPage.waitForURL("**/admin/settings?saved=theme_logo");
    await expect(adminPage.getByText("已把 LOGO 切换为该主题自带图")).toBeVisible();
    expect((await adminPage.request.get("/brand/logo")).status()).toBe(200);
    await adminPage.goto("/admin/logo");
    await expect(packLogoCard).toContainText("当前生效中");
    await expect(genericCard).not.toContainText("当前生效中");

    const guestPage = await guest.newPage();
    await guestPage.goto("/");
    expect(await dataPack(guestPage)).toBe(PACK.id);
    await expect(guestPage.locator('header img[src="/brand/logo"]')).toBeVisible();
    // 游客无主题包切换入口（无持久化载体）：菜单里不出现主题包选项
    await guestPage.getByRole("button", { name: "主题切换" }).click();
    await expect(guestPage.locator("[data-pack-option]")).toHaveCount(0);
    await guestPage.keyboard.press("Escape");

    // 用户自选优先于站点默认
    await withE2eDb((q) =>
      q.exec("UPDATE user_profiles SET theme_pack = 'default' WHERE user_id = ?", [USERS.member]),
    );
    const member = await browser.newContext();
    try {
      await loginAs(member, USERS.member);
      const memberPage = await member.newPage();
      await memberPage.goto("/");
      expect(await dataPack(memberPage)).toBe("default");
    } finally {
      await member.close();
    }

    // 改回不带 LOGO 的默认包：主题复原，LOGO 不被触碰（补充关系，非绑定）
    await adminPage.goto("/admin/settings");
    await adminPage.getByRole("radio", { name: /现代浅色/ }).check();
    await adminPage.getByRole("button", { name: "保存默认主题" }).click();
    // default 包不带 LOGO（unchanged）：专用跳转参数与文案，明确告知 LOGO 保持不变
    await adminPage.waitForURL("**/admin/settings?saved=theme_no_logo");
    await expect(
      adminPage.getByText("全站默认主题已保存（此主题无自带 LOGO，LOGO 保持不变）。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("alert").filter({ hasText: "自带 LOGO 未能切换" }),
    ).toHaveCount(0);
    expect((await adminPage.request.get("/brand/logo")).status()).toBe(200);
    await guestPage.reload();
    expect(await dataPack(guestPage)).toBe("default");
  } finally {
    await resetAll();
    await admin.close();
    await guest.close();
  }
});

test("换肤不换 DOM：客户端切包只改 data-pack 与 CSS 变量，页面节点结构与文本不变", async ({
  page,
}) => {
  await loginAs(page.context(), USERS.member);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-pack", "default");

  const before = await page.locator("main").evaluate((root) => ({
    structure: [...root.querySelectorAll("*")].map((el) => `${el.tagName}:${el.children.length}`),
    text: root.textContent,
  }));

  // 菜单交互即时切换 pack（PATCH 已由上一用例覆盖）；不导航、不重建 React 页面树
  await page.getByRole("button", { name: "主题切换" }).click();
  await page.locator('[data-pack-option="qy2010"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-pack", "qy2010");

  const after = await page.locator("main").evaluate((root) => ({
    structure: [...root.querySelectorAll("*")].map((el) => `${el.tagName}:${el.children.length}`),
    text: root.textContent,
  }));
  expect(after).toEqual(before);
});
