import { and, desc, eq, sql } from "drizzle-orm";
import { announcements, getWebDb, siteSettings } from "@funwind/db";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";

/**
 * 站点框架配置（M9，site_settings JSON，不建独立表）：导航/友链/页脚。
 * 读取走 globalThis + TTL 缓存（getAuthzSnapshot 同款模式）；管理保存后 invalidate（验收「即时生效」）。
 */

export interface NavItem {
  label: string;
  href: string;
}

export interface FriendLink {
  label: string;
  href: string;
  description?: string;
}

export interface SiteChrome {
  nav: NavItem[];
  links: FriendLink[];
  footerText: string;
  /** 当前品牌 LOGO（LOGO 池 active 文件名）；null = 无（回退占位图标） */
  logoActive: string | null;
  /** 站点身份（M10.6b）：名称/副标题；未配置回退 SITE_NAME/SITE_TAGLINE */
  identity: SiteIdentity;
}

export interface SiteIdentity {
  name: string;
  tagline: string;
}

const EMPTY: SiteChrome = {
  nav: [],
  links: [],
  footerText: "",
  logoActive: null,
  identity: { name: SITE_NAME, tagline: SITE_TAGLINE },
};
const TTL_MS = 30_000;

interface CacheBox {
  value: SiteChrome | null;
  at: number;
}

const g = globalThis as unknown as { __fwSiteChrome?: CacheBox };

/** 读取（TTL 缓存；库读失败沿用上次，冷启动失败回空——导航缺失不拖垮页面） */
export async function getSiteChrome(): Promise<SiteChrome> {
  const box = g.__fwSiteChrome;
  if (box && Date.now() - box.at < TTL_MS) return box.value ?? EMPTY;
  try {
    const rows = await getWebDb().select().from(siteSettings);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const chrome: SiteChrome = {
      nav: parseNav(byKey.get("site.nav")),
      links: parseLinks(byKey.get("site.links")),
      footerText: parseFooter(byKey.get("site.footer")),
      logoActive: parseLogo(byKey.get("site.logo")),
      identity: parseIdentity(byKey.get("site.identity")),
    };
    g.__fwSiteChrome = { value: chrome, at: Date.now() };
    return chrome;
  } catch {
    if (box) return box.value ?? EMPTY;
    return EMPTY;
  }
}

/** 管理保存后失效（下一个请求重新读库） */
export function invalidateSiteChrome(): void {
  g.__fwSiteChrome = undefined;
}

/**
 * 横幅公告（M9）：show_banner=true 且当前有效的最新一条。audience 过滤由调用方传登录态
 * （游客只看 all——与 notifications 的 validAnnouncementWhere 同口径）。
 */
export async function bannerAnnouncement(loggedIn: boolean): Promise<{
  id: number;
  title: string;
  level: "info" | "important";
} | null> {
  const [row] = await getWebDb()
    .select({ id: announcements.id, title: announcements.title, level: announcements.level })
    .from(announcements)
    .where(
      and(
        eq(announcements.showBanner, true),
        sql`NOW() >= ${announcements.startsAt}`,
        sql`(${announcements.endsAt} IS NULL OR NOW() < ${announcements.endsAt})`,
        loggedIn ? undefined : eq(announcements.audience, "all"),
      ),
    )
    .orderBy(desc(announcements.id))
    .limit(1);
  return row ?? null;
}

/** LOGO 池当前项（site.logo JSON 的 active；文件名校验与 lib/brand/logo-pool 同口径） */
function parseLogo(raw: unknown): string | null {
  const o = raw as { items?: unknown; active?: unknown } | null;
  const items = Array.isArray(o?.items) ? (o.items as { file?: unknown }[]) : [];
  const active = typeof o?.active === "string" ? o.active : null;
  if (!active || !/^logo-[a-z0-9]+\.png$/.test(active)) return null;
  return items.some((i) => i.file === active) ? active : null;
}

/** 站点身份（site.identity JSON）：空值回退默认常量；name 截 40、tagline 截 80（导出供单测） */
export function parseIdentity(raw: unknown): SiteIdentity {
  const o = raw as { name?: unknown; tagline?: unknown } | null;
  const name =
    typeof o?.name === "string" && o.name.trim() !== "" ? o.name.trim().slice(0, 40) : SITE_NAME;
  const tagline = typeof o?.tagline === "string" ? o.tagline.trim().slice(0, 80) : SITE_TAGLINE;
  return { name, tagline };
}

/** 站点身份便捷读取（走 chrome 的 TTL 缓存；管理保存后 invalidate 即时生效） */
export async function getSiteIdentity(): Promise<SiteIdentity> {
  return (await getSiteChrome()).identity;
}

function parseNav(raw: unknown): NavItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((x) => {
      const o = x as Partial<NavItem>;
      return typeof o.label === "string" && typeof o.href === "string" && o.href.startsWith("/")
        ? [{ label: o.label.slice(0, 32), href: o.href.slice(0, 200) }]
        : [];
    })
    .slice(0, 10);
}

function parseLinks(raw: unknown): FriendLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((x) => {
      const o = x as Partial<FriendLink>;
      return typeof o.label === "string" &&
        typeof o.href === "string" &&
        /^https?:\/\//.test(o.href)
        ? [
            {
              label: o.label.slice(0, 32),
              href: o.href.slice(0, 300),
              ...(typeof o.description === "string"
                ? { description: o.description.slice(0, 100) }
                : {}),
            },
          ]
        : [];
    })
    .slice(0, 20);
}

function parseFooter(raw: unknown): string {
  const o = raw as { text?: unknown } | null | undefined;
  return typeof o?.text === "string" ? o.text.slice(0, 300) : "";
}
