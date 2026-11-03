import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { withE2eDb } from "../e2e/support/db";
import { USERS, loginAs } from "../e2e/support/session";

/**
 * 视觉回归基线（M11.1 Step 6）：内置主题跨关键页面截图 + DB 自定义 Surface 首页/板块截图。
 * 运行：`pnpm test:visual`（仅本机 macOS；CI 不跑，见 playwright.visual.config.ts 头注）。
 * 更新基线：`pnpm test:visual:update`（先人工核对差异再入库）。
 *
 * 主题设置口径：
 *   · 明暗走真实路径——addInitScript 写 next-themes 的 localStorage.theme，首帧即正确；
 *   · 主题包走服务端直出路径——测试用 DB 把用户偏好（user_profiles.theme_pack）设为目标包，
 *     SSR 的 html[data-pack] 即目标值；截图前不再改属性（客户端 dataset 切换另有 E2E 覆盖）。
 * 稳定性：serial + 单 worker（配置层）；浏览量计数用 data-testid mask；滚动一屏预热懒加载。
 * 附带断言：qy2010 暗色 = 回退默认暗色——qy2010-dark 组合直接对 default-dark 基线截图。
 */

type Mode = "light" | "dark";
type Pack = string;
interface Combo {
  id: string;
  mode: Mode;
  pack: Pack;
}

const COMBOS: Combo[] = [
  { id: "default-light", mode: "light", pack: "default" },
  { id: "default-dark", mode: "dark", pack: "default" },
  { id: "qy2010-light", mode: "light", pack: "qy2010" },
];

/** upsert：演示用户的 profile 行未必存在（种子只给 alice 建），裸 UPDATE 会落空、把上一轮偏好渗进本轮 */
const setPackPref = (userId: number, pack: string) =>
  withE2eDb((q) =>
    q.exec(
      "INSERT INTO user_profiles (user_id, theme_pack) VALUES (?, ?) " +
        "ON DUPLICATE KEY UPDATE theme_pack = VALUES(theme_pack)",
      [userId, pack],
    ),
  );

const clearPackPref = (userId: number) =>
  withE2eDb((q) =>
    q.exec(
      "INSERT INTO user_profiles (user_id, theme_pack) VALUES (?, NULL) " +
        "ON DUPLICATE KEY UPDATE theme_pack = NULL",
      [userId],
    ),
  );

test.afterAll(async () => {
  // 收尾清偏好：否则本轮结尾的 qy2010 组合会渗进下一轮的 default-light 基线
  await clearPackPref(USERS.member);
  await clearPackPref(USERS.admin);
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM site_settings WHERE `key` = 'site.theme'");
    await q.exec("DELETE FROM theme_packages WHERE id = 'visual-surface'");
  });
});

// 配置已限定单 worker；每张截图软断言，让一次运行收集全部差异，仍在用例结束时判失败。

async function shot(
  page: Page,
  combo: Combo,
  name: string,
  url: string,
  opts: { mask?: string[] } = {},
) {
  await page.addInitScript(() => localStorage.removeItem("fw-banner-dismissed:901"));
  await page.goto(url);
  await page.waitForLoadState("networkidle").catch(() => {});
  // 演示夹具公告通过挂载 effect 读取关闭状态，等待页面可见状态后再建立截图。
  await expect(page.getByTestId("announcement-banner")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-pack", combo.pack);
  await expect(page.locator("html")).toHaveAttribute("data-mode", combo.mode);
  // 用即时滚动预热懒加载，避免截图时仍有滚动动画进行。
  await page.evaluate(() => window.scrollTo({ top: 1400, left: 0, behavior: "instant" }));
  await page.evaluate(() =>
    Promise.all(
      [...document.images].map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((r) => ((img.onload = r), (img.onerror = r))),
      ),
    ),
  );
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect.soft(page).toHaveScreenshot(`${name}-${combo.id}.png`, {
    mask: (opts.mask ?? []).map((sel) => page.locator(sel)),
  });
}

test("member 视角：三主题 × 首页/版块/帖子/个人/设置；qy2010 暗色回退默认暗色", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  for (const combo of COMBOS) {
    await setPackPref(USERS.member, combo.pack);
    await setPackPref(USERS.admin, combo.pack);
    const ctx = await browser.newContext({ ...testInfo.project.use });
    await ctx.addInitScript((mode) => localStorage.setItem("theme", mode), combo.mode);
    await loginAs(ctx, USERS.member);
    const page = await ctx.newPage();
    await shot(page, combo, "home", "/");
    await shot(page, combo, "boards", "/boards");
    await shot(page, combo, "thread", "/t/900004", { mask: ['[data-testid="thread-view-count"]'] });
    await shot(page, combo, "profile", "/u/90005");
    await shot(page, combo, "settings-appearance", "/settings/appearance");
    await ctx.close();
  }
  // qy2010 暗色：包的浅色限定选择器不生效 → 逐像素等于 default-dark（回退语义的视觉断言）
  await setPackPref(USERS.member, "qy2010");
  const ctx = await browser.newContext({ ...testInfo.project.use });
  await ctx.addInitScript(() => localStorage.setItem("theme", "dark"));
  await loginAs(ctx, USERS.member);
  const page = await ctx.newPage();
  await shot(page, { id: "default-dark", mode: "dark", pack: "qy2010" }, "home", "/");
  await shot(page, { id: "default-dark", mode: "dark", pack: "qy2010" }, "boards", "/boards");
  await ctx.close();
});

test("admin 视角：三主题 × 站点配置（含全站默认主题卡）", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  for (const combo of COMBOS) {
    await setPackPref(USERS.admin, combo.pack);
    const ctx = await browser.newContext({ ...testInfo.project.use });
    await ctx.addInitScript((mode) => localStorage.setItem("theme", mode), combo.mode);
    await loginAs(ctx, USERS.admin);
    const page = await ctx.newPage();
    await shot(page, combo, "admin-settings", "/admin/settings");
    await ctx.close();
  }
});

test("游客视角：登录页三主题（真实后台切默认主题，清理 LOGO 联动副作用）", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const adminContext = await browser.newContext({ ...testInfo.project.use });
  await loginAs(adminContext, USERS.admin);
  const adminPage = await adminContext.newPage();
  const setSitePack = async (pack: string) => {
    await adminPage.goto("/admin/themes");
    const card = adminPage
      .locator("div.rounded-xl.border.bg-card")
      .filter({ has: adminPage.locator(`a[href="/admin/themes/${pack}"]`) });
    const button = card.getByRole("button", { name: "设为默认", exact: true });
    if (await button.count()) {
      await button.click();
      await expect(adminPage).toHaveURL(/saved=default/);
    }
  };
  try {
    for (const combo of COMBOS) {
      await setSitePack(combo.pack);
      const ctx = await browser.newContext({ ...testInfo.project.use });
      try {
        await ctx.addInitScript((mode) => localStorage.setItem("theme", mode), combo.mode);
        const page = await ctx.newPage();
        await shot(page, combo, "login", "/login");
      } finally {
        await ctx.close();
      }
    }
  } finally {
    try {
      await setSitePack("default");
      await adminPage.goto("/admin/logo");
      const bundledLogo = adminPage
        .locator("div.rounded-xl.border.bg-card")
        .filter({ hasText: "复刻·青翼2010 自带" });
      if (await bundledLogo.count()) {
        await bundledLogo.getByRole("button", { name: "移除", exact: true }).click();
        await adminPage.getByRole("button", { name: "确认", exact: true }).click();
        await expect(bundledLogo).toHaveCount(0);
      }
    } finally {
      await adminContext.close();
    }
  }
});

test("DB 自定义主题：Surface 变量浅色预览与暗色档", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const id = "visual-surface";
  const adminContext = await browser.newContext({ ...testInfo.project.use });
  const adminPage = await adminContext.newPage();
  try {
    await withE2eDb((q) => q.exec("DELETE FROM theme_packages WHERE id = ?", [id]));
    await loginAs(adminContext, USERS.admin);
    await adminPage.goto("/admin/themes");
    await adminPage.getByLabel("包 id", { exact: true }).fill(id);
    await adminPage.getByLabel("名称").fill("Surface 视觉测试主题");
    await adminPage.getByRole("button", { name: "新建主题包" }).click();
    await expect(adminPage).toHaveURL(new RegExp(`saved=created&id=${id}`));

    // 先在装饰素材池上传一张底纹（验证 ?file= 取图链路在真实前台生效）
    await adminPage.goto("/admin/decor");
    await adminPage.getByLabel(/名称/).fill("视觉底纹");
    await adminPage.getByLabel(/PNG 文件/).setInputFiles({
      name: "visual-decor.png",
      mimeType: "image/png",
      buffer: await sharp({
        create: { width: 480, height: 300, channels: 3, background: "#c8b89a" },
      })
        .png()
        .toBuffer(),
    });
    await adminPage.getByRole("button", { name: "上传入池" }).click();
    await adminPage.waitForURL("**/admin/decor?added=*");
    const decorFile = new URL(adminPage.url()).searchParams.get("added")!;
    expect(decorFile).toMatch(/^decor-[a-f0-9]{32}\.png$/);

    const definition = {
      pwa: { themeColor: "#5b21b6", backgroundColor: "#f8f5e8" },
      surfaces: {
        header: {
          light: {
            fill: {
              type: "linear",
              angle: 110,
              stops: [
                { color: "#1e1b4b", alpha: 1, position: 0 },
                { color: "#4338ca", alpha: 1, position: 100 },
              ],
            },
            border: { color: "#c4b5fd", width: 1, style: "solid" },
            text: { primary: "#ffffff", muted: "#e0e7ff", link: "#fde68a" },
          },
          dark: { fill: { type: "solid", color: "#111827" } },
        },
        "hero-brand": {
          light: {
            fill: { type: "solid", color: "#f5d0fe" },
            text: { primary: "#581c87", muted: "#7e22ce", link: "#6b21a8" },
          },
        },
        "banner-announce": {
          light: {
            fill: {
              type: "linear",
              angle: 90,
              stops: [
                { color: "#fef3c7", alpha: 1, position: 0 },
                { color: "#fde68a", alpha: 1, position: 100 },
              ],
            },
            text: { primary: "#78350f", muted: "#92400e", link: "#7c2d12" },
          },
        },
        "forum-band": {
          light: {
            // 图片底纹（验证 decor ?file= 取图在真实前台生效）
            fill: {
              type: "image",
              asset: decorFile,
              position: "center",
              size: "cover",
              repeat: "no-repeat",
              blend: "normal",
              opacity: 1,
            },
            overlay: {
              type: "linear",
              angle: 105,
              stops: [
                { color: "#e0f2fe", alpha: 0, position: 50 },
                { color: "#e0f2fe", alpha: 1, position: 100 },
              ],
            },
          },
        },
        page: { light: { fill: { type: "solid", color: "#f8f5e8" } } },
      },
    };
    await withE2eDb((q) =>
      q.exec("UPDATE theme_packages SET definition = ? WHERE id = ?", [
        JSON.stringify(definition),
        id,
      ]),
    );
    await adminPage.goto(`/admin/themes/${id}`);
    await adminPage.getByRole("button", { name: "保存主题包" }).click();
    await expect(adminPage).toHaveURL(
      (url) => url.pathname === `/admin/themes/${id}` && url.searchParams.get("saved") === "1",
    );
    expect(new URL(adminPage.url()).searchParams.get("ack")).toMatch(/^[a-f0-9-]{36}$/);

    await setPackPref(USERS.member, id);
    for (const mode of ["light", "dark"] as const) {
      const combo = { id: `custom-${mode}`, mode, pack: id };
      const context = await browser.newContext({ ...testInfo.project.use });
      await context.addInitScript((value) => localStorage.setItem("theme", value), mode);
      await loginAs(context, USERS.member);
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-pack", id);
      await shot(page, combo, "home", "/");
      await shot(page, combo, "boards", "/boards");
      await context.close();
    }

    // 主题编辑工作区（后台视角）：Surface 导航 + 属性表单 + 真实组件预览 + 内嵌素材库。
    // 仅桌面截——移动端素材卡片纵向堆叠使遮罩区域随池内容变化，逐像素对比必然抖动。
    if (testInfo.project.name === "desktop") {
      await adminPage.goto(`/admin/themes/${id}`);
      await adminPage.waitForLoadState("networkidle").catch(() => {});
      await adminPage.waitForTimeout(500);
      await expect(adminPage.getByTestId("theme-preview")).toBeVisible();
      await expect(adminPage.getByTestId("theme-asset-library")).toBeVisible();
      await expect(adminPage).toHaveScreenshot("theme-workspace.png", {
        fullPage: true,
        mask: [adminPage.locator('[data-testid="theme-asset-library"] li')],
      });
    }
  } finally {
    await clearPackPref(USERS.member);
    try {
      await adminPage.goto("/admin/themes");
      const themeCard = adminPage
        .locator("div.rounded-xl.border.bg-card")
        .filter({ has: adminPage.locator(`a[href="/admin/themes/${id}"]`) });
      if (await themeCard.count()) {
        await themeCard.getByRole("button", { name: "删除" }).click();
        await adminPage.getByRole("button", { name: "确认" }).click();
        await expect(adminPage).toHaveURL(/saved=deleted/);
      }
    } catch {
      await withE2eDb((q) => q.exec("DELETE FROM theme_packages WHERE id = ?", [id]));
    }
    await adminContext.close();
  }
});
