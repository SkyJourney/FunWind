// @vitest-environment node
/** 站点框架配置（M9）：解析容错、TTL 缓存、失效、横幅查询的有效性口径。 */
import { eq, sql } from "drizzle-orm";
import { announcements, getWebDb, siteSettings, themePackages } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import { bannerAnnouncement, getSiteChrome, invalidateSiteChrome } from "./site-chrome";

let tdb: TempDb;
const db = () => getWebDb();

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("站点框架配置（site-chrome）", () => {
  it("默认空配置；非法结构被丢弃（不抛错）", async () => {
    expect(await getSiteChrome()).toEqual({
      nav: [],
      links: [],
      footerText: "",
      logoActive: null,
      heroActive: null, // M11：Hero 池无当前项 → 首页不占位
      identity: { name: SITE_NAME, tagline: SITE_TAGLINE, url: SITE_URL }, // M10.6：身份可配（含访问地址），空库回默认
      themePack: "default", // M11：全站默认主题包未配置 → default
    });
    await db()
      .insert(siteSettings)
      .values([
        {
          key: "site.nav",
          value: [
            { label: "站外", href: "https://evil" },
            { label: "站内", href: "/f/951" },
          ],
          updatedAt: sql`NOW()`,
        },
        {
          key: "site.links",
          value: [
            { label: "友链", href: "/not-http" },
            { label: "好的", href: "https://a.b" },
          ],
          updatedAt: sql`NOW()`,
        },
        { key: "site.footer", value: "不是对象", updatedAt: sql`NOW()` },
      ])
      .onDuplicateKeyUpdate({ set: { value: sql`VALUES(value)` } });
    invalidateSiteChrome();
    const chrome = await getSiteChrome();
    expect(chrome.nav).toEqual([{ label: "站内", href: "/f/951" }]); // 非站内 href 丢弃
    expect(chrome.links).toEqual([{ label: "好的", href: "https://a.b" }]);
    expect(chrome.footerText).toBe(""); // 非对象回空
    for (const k of ["site.nav", "site.links", "site.footer"]) {
      await db().delete(siteSettings).where(eq(siteSettings.key, k));
    }
    invalidateSiteChrome();
  });

  it("合法配置读回；invalidate 后重新读库（缓存失效即时生效）", async () => {
    await db()
      .insert(siteSettings)
      .values([
        { key: "site.nav", value: [{ label: "动画", href: "/f/951" }], updatedAt: sql`NOW()` },
        { key: "site.footer", value: { text: "© 青翼" }, updatedAt: sql`NOW()` },
      ])
      .onDuplicateKeyUpdate({ set: { value: sql`VALUES(value)` } });
    invalidateSiteChrome();
    const chrome = await getSiteChrome();
    expect(chrome.nav).toEqual([{ label: "动画", href: "/f/951" }]);
    expect(chrome.footerText).toBe("© 青翼");

    // 直接改库（绕过 invalidate）→ TTL 内仍是旧值；invalidate 后读到新值
    await db()
      .update(siteSettings)
      .set({ value: { text: "© 新" }, updatedAt: sql`NOW()` })
      .where(eq(siteSettings.key, "site.footer"));
    expect((await getSiteChrome()).footerText).toBe("© 青翼");
    invalidateSiteChrome();
    expect((await getSiteChrome()).footerText).toBe("© 新");
    await db().delete(siteSettings).where(eq(siteSettings.key, "site.nav"));
    await db().delete(siteSettings).where(eq(siteSettings.key, "site.footer"));
    invalidateSiteChrome();
  });

  it("品牌素材池当前项（site.logo / site.hero）：前缀校验 + 必须在清单内；跨池文件名不串台", async () => {
    await db()
      .insert(siteSettings)
      .values([
        {
          key: "site.hero",
          value: { items: [{ file: "hero-aaaa.png", name: "横幅" }], active: "hero-aaaa.png" },
          updatedAt: sql`NOW()`,
        },
        {
          key: "site.logo",
          value: { items: [{ file: "logo-bbbb.png", name: "LOGO" }], active: "hero-aaaa.png" },
          updatedAt: sql`NOW()`,
        },
      ])
      .onDuplicateKeyUpdate({ set: { value: sql`VALUES(value)` } });
    invalidateSiteChrome();
    const chrome = await getSiteChrome();
    expect(chrome.heroActive).toBe("hero-aaaa.png");
    expect(chrome.logoActive).toBeNull(); // logo 池 active 指向 hero 文件名 → 悬空
    for (const k of ["site.hero", "site.logo"]) {
      await db().delete(siteSettings).where(eq(siteSettings.key, k));
    }
    invalidateSiteChrome();
  });

  it("全站默认主题（M11，site.theme）：合法包读回；不在注册表回 default；invalidate 即时生效", async () => {
    await db()
      .insert(siteSettings)
      .values({ key: "site.theme", value: { pack: "qy2010" }, updatedAt: sql`NOW()` })
      .onDuplicateKeyUpdate({ set: { value: sql`VALUES(value)` } });
    invalidateSiteChrome();
    expect((await getSiteChrome()).themePack).toBe("qy2010");

    await db()
      .update(siteSettings)
      .set({ value: { pack: "retired-pack" }, updatedAt: sql`NOW()` })
      .where(eq(siteSettings.key, "site.theme"));
    expect((await getSiteChrome()).themePack).toBe("qy2010"); // TTL 内旧值
    invalidateSiteChrome();
    expect((await getSiteChrome()).themePack).toBe("default"); // 未知 id 回退

    await db().delete(siteSettings).where(eq(siteSettings.key, "site.theme"));
    invalidateSiteChrome();
  });

  it("site.theme 可解析启用的 DB 自定义包，停用后按目录校验回退 default", async () => {
    const id = "chrome-db-theme";
    await db()
      .insert(themePackages)
      .values({
        id,
        name: "测试动态主题",
        description: "",
        schemaVersion: 1,
        definition: { surfaces: {}, pwa: { themeColor: "#112233", backgroundColor: "#f0f0f0" } },
        assets: [],
        enabled: true,
        isBuiltin: false,
        revision: 1,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      });
    await db()
      .insert(siteSettings)
      .values({ key: "site.theme", value: { pack: id }, updatedAt: sql`NOW()` })
      .onDuplicateKeyUpdate({ set: { value: sql`VALUES(value)` } });
    invalidateThemeCatalog();
    invalidateSiteChrome();
    expect((await getSiteChrome()).themePack).toBe(id);

    await db().update(themePackages).set({ enabled: false }).where(eq(themePackages.id, id));
    invalidateThemeCatalog();
    invalidateSiteChrome();
    expect((await getSiteChrome()).themePack).toBe("default");

    await db().delete(themePackages).where(eq(themePackages.id, id));
    await db().delete(siteSettings).where(eq(siteSettings.key, "site.theme"));
    invalidateThemeCatalog();
    invalidateSiteChrome();
  });

  it("横幅查询：只取 show_banner 且有效；audience 过滤游客；下线后消失", async () => {
    // seed 公告 901（all、showBanner、长期）应命中
    expect(await bannerAnnouncement(false)).toMatchObject({ id: 901 });

    await db().insert(announcements).values({
      id: 902,
      title: "会员横幅",
      bodyMd: "",
      level: "important",
      audience: "members",
      showBanner: true,
      startsAt: "2026-01-01 00:00:00",
      endsAt: null,
      createdBy: 90004,
      createdAt: "2026-01-01 00:00:00",
      updatedAt: "2026-01-01 00:00:00",
    });
    expect(await bannerAnnouncement(false)).toMatchObject({ id: 901 });
    expect(await bannerAnnouncement(true)).toMatchObject({ id: 902 });

    await db()
      .update(announcements)
      .set({ endsAt: "2026-01-02 00:00:00" })
      .where(eq(announcements.id, 902));
    expect(await bannerAnnouncement(true)).toMatchObject({ id: 901 });
    await db().delete(announcements).where(eq(announcements.id, 902));
  });
});
