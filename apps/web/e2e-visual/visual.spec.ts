import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "../e2e/support/db";
import { USERS, loginAs } from "../e2e/support/session";

/**
 * 视觉回归基线（M11 Step 6）：三主题 × 关键页面（首页/版块/帖子/个人/设置/后台/登录）截图对比。
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
type Pack = "default" | "qy2010";
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
  await withE2eDb((q) => q.exec("DELETE FROM site_settings WHERE `key` = 'site.theme'"));
});

test.describe.configure({ mode: "serial" });

async function shot(
  page: Page,
  combo: Combo,
  name: string,
  url: string,
  opts: { mask?: string[] } = {},
) {
  await page.goto(url);
  await page.waitForLoadState("networkidle").catch(() => {});
  // 滚动一屏预热懒加载（板块图/头像），等所有图片真正加载完成再回顶——
  // 否则截图撞上懒加载竞态会整页布局微移（Step 6 首跑实测）
  await page.mouse.wheel(0, 1400);
  await page.evaluate(() =>
    Promise.all(
      [...document.images].map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((r) => ((img.onload = r), (img.onerror = r))),
      ),
    ),
  );
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await expect(page).toHaveScreenshot(`${name}-${combo.id}.png`, {
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

test("游客视角：登录页三主题（站点默认主题包经 DB 切换，跑完复原）", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const setSitePack = (pack: string) =>
    withE2eDb(async (q) => {
      await q.exec(
        "INSERT INTO site_settings (`key`, `value`, `updated_at`) VALUES ('site.theme', JSON_OBJECT('pack', ?), NOW()) " +
          "ON DUPLICATE KEY UPDATE `value` = JSON_OBJECT('pack', ?), `updated_at` = NOW()",
        [pack, pack],
      );
    });
  try {
    for (const combo of COMBOS) {
      await setSitePack(combo.pack);
      const ctx = await browser.newContext({ ...testInfo.project.use });
      await ctx.addInitScript((mode) => localStorage.setItem("theme", mode), combo.mode);
      const page = await ctx.newPage();
      await shot(page, combo, "login", "/login");
      await ctx.close();
    }
  } finally {
    await withE2eDb((q) => q.exec("DELETE FROM site_settings WHERE `key` = 'site.theme'"));
  }
});
