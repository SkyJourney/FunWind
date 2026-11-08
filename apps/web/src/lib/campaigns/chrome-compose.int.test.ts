// @vitest-environment node
/**
 * 运营排期 × 站点框架读取链（M11.2 Step 3）：真实临时 MySQL。
 * 覆盖：命中 / 未开始 / 已结束 / 长期 / 停用 / 同 effect 优先级 / 引用失效回退 / 输出地址。
 */
import { eq, sql } from "drizzle-orm";
import { campaigns, getWebDb, siteSettings, themePackages } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { invalidateSiteChrome, getSiteChrome } from "@/lib/chrome/site-chrome";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import { resolveEffectivePack } from "@/lib/theme/pref";

let tdb: TempDb;
const db = () => getWebDb();

beforeAll(async () => {
  tdb = await setupTempDb();
  // qy2010 已移出内置种子（站长 2026-11-08）：作为「数据库启用的自定义包」夹具行插入
  await db()
    .insert(themePackages)
    .values({
      id: "qy2010",
      name: "复刻·青翼2010",
      description: "",
      schemaVersion: 1,
      definition: { surfaces: {} },
      assets: [],
      enabled: true,
      isBuiltin: false,
      revision: 1,
      createdAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    });
  invalidateThemeCatalog();
});

afterAll(async () => {
  await tdb?.teardown();
});

const PACK = "xmas-test";
const LOGO = "logo-aaaa1111.png";
const HERO = "hero-bbbb2222.png";

/** NOW() 前后偏移秒数的 DATETIME 表达式，窗口边界全部交给 MySQL 判定 */
const offset = (seconds: number) => sql`NOW() + INTERVAL ${seconds} SECOND`;

async function addPack(enabled = true) {
  await db()
    .insert(themePackages)
    .values({
      id: PACK,
      name: "圣诞测试包",
      description: "",
      schemaVersion: 1,
      definition: { surfaces: {}, pwa: { themeColor: "#112233", backgroundColor: "#f0f0f0" } },
      assets: [],
      enabled,
      isBuiltin: false,
      revision: 1,
      createdAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    });
  invalidateThemeCatalog();
}

async function addCampaign(over: {
  effect: string;
  config: unknown;
  startsAt?: ReturnType<typeof offset>;
  endsAt?: ReturnType<typeof offset> | null;
  enabled?: boolean;
  priority?: number;
}) {
  await db()
    .insert(campaigns)
    .values({
      name: `测试 ${over.effect}`,
      effect: over.effect,
      config: over.config as object,
      startsAt: over.startsAt ?? offset(-60),
      endsAt: over.endsAt === undefined ? offset(3600) : over.endsAt,
      enabled: over.enabled ?? true,
      priority: over.priority ?? 0,
      revision: 1,
      createdAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    });
  invalidateSiteChrome();
}

async function setPool(key: "site.logo" | "site.hero", file: string, active: string | null) {
  await db()
    .insert(siteSettings)
    .values({ key, value: { items: [{ file, name: "素材" }], active }, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: sql`VALUES(value)` } });
  invalidateSiteChrome();
}

afterEach(async () => {
  await db().delete(campaigns);
  await db().delete(themePackages).where(eq(themePackages.id, PACK));
  await db().delete(siteSettings).where(eq(siteSettings.key, "site.logo"));
  await db().delete(siteSettings).where(eq(siteSettings.key, "site.hero"));
  await db().delete(siteSettings).where(eq(siteSettings.key, "site.theme"));
  invalidateThemeCatalog();
  invalidateSiteChrome();
});

describe.skipIf(skipDb)("排期覆盖主题包", () => {
  it("时间窗内命中 → 站点默认主题变为排期包", async () => {
    await addPack();
    await addCampaign({ effect: "theme.pack", config: { pack: PACK } });
    expect((await getSiteChrome()).themePack).toBe(PACK);
  });

  it("未开始 → 不生效", async () => {
    await addPack();
    await addCampaign({
      effect: "theme.pack",
      config: { pack: PACK },
      startsAt: offset(600),
      endsAt: offset(7200),
    });
    expect((await getSiteChrome()).themePack).toBe("default");
  });

  it("已结束 → 回退常态（到期不需要任何写回）", async () => {
    await addPack();
    await addCampaign({
      effect: "theme.pack",
      config: { pack: PACK },
      startsAt: offset(-7200),
      endsAt: offset(-60),
    });
    expect((await getSiteChrome()).themePack).toBe("default");
  });

  it("结束时刻恰为当前 → 已结束（右端开区间）", async () => {
    await addPack();
    await addCampaign({
      effect: "theme.pack",
      config: { pack: PACK },
      startsAt: offset(-7200),
      endsAt: sql`NOW()`,
    });
    expect((await getSiteChrome()).themePack).toBe("default");
  });

  it("开始时刻恰为当前 → 已生效（左端闭区间）", async () => {
    await addPack();
    await addCampaign({
      effect: "theme.pack",
      config: { pack: PACK },
      startsAt: sql`NOW()`,
    });
    expect((await getSiteChrome()).themePack).toBe(PACK);
  });

  it("结束时间为空 = 长期有效", async () => {
    await addPack();
    await addCampaign({
      effect: "theme.pack",
      config: { pack: PACK },
      startsAt: offset(-86400 * 365),
      endsAt: null,
    });
    expect((await getSiteChrome()).themePack).toBe(PACK);
  });

  it("停用的方案不生效，即使时间窗命中", async () => {
    await addPack();
    await addCampaign({ effect: "theme.pack", config: { pack: PACK }, enabled: false });
    expect((await getSiteChrome()).themePack).toBe("default");
  });

  it("排期包被停用 → 逐项回退到 site.theme，不报错", async () => {
    await addPack(false);
    await db()
      .insert(siteSettings)
      .values({ key: "site.theme", value: { pack: "qy2010" }, updatedAt: sql`NOW()` });
    await addCampaign({ effect: "theme.pack", config: { pack: PACK } });
    expect((await getSiteChrome()).themePack).toBe("qy2010");
  });

  it("同 effect 多条命中：priority 大者胜", async () => {
    await addPack();
    await addCampaign({ effect: "theme.pack", config: { pack: "qy2010" }, priority: 1 });
    await addCampaign({ effect: "theme.pack", config: { pack: PACK }, priority: 9 });
    expect((await getSiteChrome()).themePack).toBe(PACK);
  });

  it("用户自选偏好仍优先于排期（排期只覆盖站点默认）", async () => {
    await addPack();
    await addCampaign({ effect: "theme.pack", config: { pack: PACK } });
    const chrome = await getSiteChrome();
    expect(resolveEffectivePack("qy2010", chrome.themePack)).toBe("qy2010");
    expect(resolveEffectivePack(null, chrome.themePack)).toBe(PACK);
  });

  it("库里写坏的配置 / 未注册 effect 被跳过，其余生效", async () => {
    await addPack();
    await addCampaign({ effect: "theme.pack", config: { pack: "BAD ID" }, priority: 99 });
    await addCampaign({ effect: "site.decor", config: { file: "decor-x.png" } });
    await addCampaign({ effect: "theme.pack", config: { pack: PACK }, priority: 0 });
    expect((await getSiteChrome()).themePack).toBe(PACK);
  });
});

describe.skipIf(skipDb)("排期覆盖 LOGO / Hero", () => {
  it("无排期：输出地址保持原样（读池当前项）", async () => {
    await setPool("site.logo", LOGO, LOGO);
    const chrome = await getSiteChrome();
    expect(chrome.logoActive).toBe(LOGO);
    expect(chrome.logoUrl).toBe("/brand/logo");
  });

  it("排期文件在池内且不同于当前项 → 带 ?file= 输出", async () => {
    await db()
      .insert(siteSettings)
      .values({
        key: "site.logo",
        value: {
          items: [
            { file: LOGO, name: "日常" },
            { file: "logo-cccc3333.png", name: "节日" },
          ],
          active: LOGO,
        },
        updatedAt: sql`NOW()`,
      });
    await addCampaign({ effect: "site.logo", config: { file: "logo-cccc3333.png" } });
    const chrome = await getSiteChrome();
    expect(chrome.logoActive).toBe("logo-cccc3333.png");
    expect(chrome.logoUrl).toBe("/brand/logo?file=logo-cccc3333.png");
  });

  it("排期文件就是当前项 → 地址不带参数（不无谓打破缓存）", async () => {
    await setPool("site.logo", LOGO, LOGO);
    await addCampaign({ effect: "site.logo", config: { file: LOGO } });
    expect((await getSiteChrome()).logoUrl).toBe("/brand/logo");
  });

  it("排期文件已不在池内 → 回退池当前项，不输出悬空地址", async () => {
    await setPool("site.logo", LOGO, LOGO);
    await addCampaign({ effect: "site.logo", config: { file: "logo-dead0000.png" } });
    const chrome = await getSiteChrome();
    expect(chrome.logoActive).toBe(LOGO);
    expect(chrome.logoUrl).toBe("/brand/logo");
  });

  it("池里没有当前项但排期命中 → 仍可显示排期文件", async () => {
    await setPool("site.hero", HERO, null);
    await addCampaign({ effect: "site.hero", config: { file: HERO } });
    const chrome = await getSiteChrome();
    expect(chrome.heroActive).toBe(HERO);
    expect(chrome.heroUrl).toBe(`/brand/hero?file=${HERO}`);
  });

  it("排期到期 → heroUrl 回到常态；LOGO 与 Hero 互不影响", async () => {
    await setPool("site.hero", HERO, null);
    await setPool("site.logo", LOGO, LOGO);
    await addCampaign({
      effect: "site.hero",
      config: { file: HERO },
      startsAt: offset(-7200),
      endsAt: offset(-60),
    });
    const chrome = await getSiteChrome();
    expect(chrome.heroUrl).toBeNull();
    expect(chrome.logoUrl).toBe("/brand/logo");
  });
});
