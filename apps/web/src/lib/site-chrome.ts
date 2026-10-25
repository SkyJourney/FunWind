import { and, desc, eq, sql } from "drizzle-orm";
import { announcements, getWebDb, siteSettings } from "@funwind/db";

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
}

const EMPTY: SiteChrome = { nav: [], links: [], footerText: "" };
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
