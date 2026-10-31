import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * 主题包偏好与站点默认（M11 Step 2，docs/THEME-SYSTEM.md §2）：
 *   · 外观页表单：自选主题包 → html[data-pack] 服务端直出、刷新与跨页保持；「跟随站点默认」回落；
 *   · 顶栏菜单即时切换：改属性零重载 + PATCH 持久化 → 刷新保持；
 *   · 后台全站默认：保存即生效，游客与未自选用户跟随；改回后复原。
 * qy2010 在 Step 2 仅为骨架（色板 Step 4 填），本案只断言 data-pack 值与持久化，不断言视觉。
 * 站点默认是全局状态：本文件串行，且每案结束与 afterAll 都复位（自愈）。
 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

const dataPack = (page: Page) => page.locator("html").getAttribute("data-pack");

const resetAll = () =>
  withE2eDb(async (q) => {
    await q.exec("DELETE FROM site_settings WHERE `key` = 'site.theme'");
    await q.exec("UPDATE user_profiles SET theme_pack = NULL WHERE user_id IN (?, ?)", [
      USERS.member,
      USERS.admin,
    ]);
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

test("后台全站默认：保存即生效，游客跟随；用户自选优先；改回后复原", async ({ browser }) => {
  const admin = await browser.newContext();
  const guest = await browser.newContext();
  try {
    await loginAs(admin, USERS.admin);
    const adminPage = await admin.newPage();
    await adminPage.goto("/admin/settings");
    await adminPage.getByRole("radio", { name: /复刻·青翼2010/ }).check();
    await adminPage.getByRole("button", { name: "保存默认主题" }).click();
    await adminPage.waitForURL("**/admin/settings?saved=theme");
    await expect(adminPage.getByText("全站默认主题已保存并即时生效")).toBeVisible();
    // qy2010 不带 LOGO：flash 文案明示 LOGO 保持不变（联动"无图不触碰"分支）
    await expect(adminPage.getByText("LOGO 保持不变")).toBeVisible();

    const guestPage = await guest.newPage();
    await guestPage.goto("/");
    expect(await dataPack(guestPage)).toBe("qy2010");
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

    await adminPage.goto("/admin/settings");
    await adminPage.getByRole("radio", { name: /现代浅色/ }).check();
    await adminPage.getByRole("button", { name: "保存默认主题" }).click();
    await adminPage.waitForURL("**/admin/settings?saved=theme");
    await guestPage.reload();
    expect(await dataPack(guestPage)).toBe("default");
  } finally {
    await resetAll();
    await admin.close();
    await guest.close();
  }
});
