import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { announcements, getWebDb, siteSettings } from "@funwind/db";
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";
import { DEFAULT_PACK } from "@/lib/theme-packs";
import { isKnownPackId } from "@/lib/theme/catalog";
import { getActiveCampaignConfigs } from "@/lib/campaigns/service";
import {
  applyRegisterWindow,
  registerAvailability,
  resolveRegisterPolicy,
} from "@/lib/auth/register-policy";

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
  /** 首页 Hero 横幅当前项（M11 插槽 ⑤，Hero 池 active 文件名）；null = 无（首页不占位） */
  heroActive: string | null;
  /**
   * LOGO / Hero 的实际输出地址（M11.2）：无排期覆盖时是 `/brand/logo`、`/brand/hero`（读池当前项，行为不变）；
   * 排期命中且文件在池内时带 `?file=`。调用方一律用这两个字段，不再自己拼路径。
   */
  logoUrl: string | null;
  heroUrl: string | null;
  /** 站点身份（M10.6b）：名称/副标题；未配置回退 SITE_NAME/SITE_TAGLINE */
  identity: SiteIdentity;
  /** 全站默认主题包（M11，site.theme）：用户未设偏好时生效；未配置/未知 id 回退 default */
  themePack: string;
  /**
   * 当前是否开放注册（M11.3：开放或邀请至少开一个）。顶栏据此决定是否显示「注册」入口，
   * 避免注册关闭时仍引导访客点进一个只会说「不开放」的页面。走本缓存（30 秒）、不增加查询；
   * 注册页与注册 Action 各自重新读策略，所以这里的短暂滞后只影响入口显隐，不影响拒绝与否。
   */
  registrationOpen: boolean;
}

export interface SiteIdentity {
  name: string;
  tagline: string;
  /** 对外访问地址（邮件链接/sitemap 用）；空 = 回退 env APP_URL。Cookie Secure 等部署拓扑仍由 env 决定 */
  url: string;
}

const EMPTY: SiteChrome = {
  nav: [],
  links: [],
  footerText: "",
  logoActive: null,
  heroActive: null,
  logoUrl: null,
  heroUrl: null,
  identity: { name: SITE_NAME, tagline: SITE_TAGLINE, url: SITE_URL },
  themePack: DEFAULT_PACK,
  registrationOpen: true,
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
    const campaign = await getActiveCampaignConfigs();
    const logo = composeBrand(byKey.get("site.logo"), "logo", campaign.get("site.logo"));
    const hero = composeBrand(byKey.get("site.hero"), "hero", campaign.get("site.hero"));
    const chrome: SiteChrome = {
      nav: parseNav(byKey.get("site.nav")),
      links: parseLinks(byKey.get("site.links")),
      footerText: parseFooter(byKey.get("site.footer")),
      logoActive: logo.file,
      heroActive: hero.file,
      logoUrl: logo.file ? brandUrl("logo", logo) : null,
      heroUrl: hero.file ? brandUrl("hero", hero) : null,
      identity: parseIdentity(byKey.get("site.identity")),
      themePack: await resolveSiteThemePack(byKey.get("site.theme"), campaign.get("theme.pack")),
      // 顶栏「注册」入口与注册页 / 注册 Action 读同一生效值（M11.4 Step 2）：
      // 套用同一条窗口叠加规则（campaign 已在上面读取，不多查库）；本函数有 30 秒 TTL，
      // 窗口开始 / 结束时顶栏最多延迟 30 秒（M11.4 §2.2 F2 / 遗留事项）。
      registrationOpen:
        registerAvailability(
          applyRegisterWindow(
            resolveRegisterPolicy(byKey.get("register.policy"), byKey.get("register.mode")).policy,
            campaign.has("register.open"),
          ),
        ).kind !== "closed",
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

/** 品牌素材池当前项（site.logo / site.hero JSON 的 active；文件名校验与 lib/brand/brand-pool 同口径） */
function parseBrandActive(raw: unknown, prefix: "logo" | "hero"): string | null {
  const o = raw as { items?: unknown; active?: unknown } | null;
  const items = Array.isArray(o?.items) ? (o.items as { file?: unknown }[]) : [];
  const active = typeof o?.active === "string" ? o.active : null;
  if (!active || !new RegExp(`^${prefix}-[a-z0-9]+\\.png$`).test(active)) return null;
  return items.some((i) => i.file === active) ? active : null;
}

/** 站点身份（site.identity JSON）：空值回退默认常量；name 截 40、tagline 截 80；url 须 http(s):// 且去尾斜杠（导出供单测） */
export function parseIdentity(raw: unknown): SiteIdentity {
  const o = raw as { name?: unknown; tagline?: unknown; url?: unknown } | null;
  const name =
    typeof o?.name === "string" && o.name.trim() !== "" ? o.name.trim().slice(0, 40) : SITE_NAME;
  const tagline = typeof o?.tagline === "string" ? o.tagline.trim().slice(0, 80) : SITE_TAGLINE;
  const rawUrl = typeof o?.url === "string" ? o.url.trim().replace(/\/+$/, "") : "";
  const url = /^https?:\/\/.+/.test(rawUrl) ? rawUrl.slice(0, 200) : SITE_URL;
  return { name, tagline, url };
}

/** 站点身份便捷读取（走 chrome 的 TTL 缓存；管理保存后 invalidate 即时生效） */
export async function getSiteIdentity(): Promise<SiteIdentity> {
  return (await getSiteChrome()).identity;
}

/** 从 site.theme 解析符合包 id 语法的候选值 */
function themePackCandidate(raw: unknown): string | null {
  const pack = (raw as { pack?: unknown } | null)?.pack;
  return typeof pack === "string" && /^[a-z0-9][a-z0-9_-]{1,31}$/.test(pack) ? pack : null;
}

/**
 * 站点默认主题包：排期命中的包优先（M11.2），必须仍在目录中（启用）才采用；
 * 否则回到 site.theme，再不行回 default。排期只覆盖「站点默认」，用户自选偏好仍在更上一层优先。
 */
async function resolveSiteThemePack(raw: unknown, scheduled?: unknown): Promise<string> {
  const scheduledPack = (scheduled as { pack?: unknown } | undefined)?.pack;
  if (typeof scheduledPack === "string" && (await isKnownPackId(scheduledPack))) {
    return scheduledPack;
  }
  const candidate = themePackCandidate(raw);
  return candidate && (await isKnownPackId(candidate)) ? candidate : DEFAULT_PACK;
}

/** 品牌素材的合成结果：file 为实际生效文件；scheduled 表示它来自排期而非池当前项 */
interface BrandCompose {
  file: string | null;
  scheduled: boolean;
}

/**
 * LOGO / Hero 合成（M11.2）：排期配置的文件必须仍在对应素材池清单内才采用（池里删了就回退常态，
 * 不输出悬空地址）；其余沿用池当前项。pwa 图标等其他消费者读 logoActive 也随之一致。
 */
function composeBrand(raw: unknown, prefix: "logo" | "hero", scheduled?: unknown): BrandCompose {
  const base = parseBrandActive(raw, prefix);
  const file = (scheduled as { file?: unknown } | undefined)?.file;
  if (typeof file === "string") {
    const items = (raw as { items?: unknown } | null)?.items;
    const inPool =
      Array.isArray(items) && (items as { file?: unknown }[]).some((item) => item.file === file);
    if (inPool) return { file, scheduled: file !== base };
  }
  return { file: base, scheduled: false };
}

/** 无排期覆盖时保持原地址（读池当前项）；排期命中时显式带 file，避免被 5 分钟缓存的旧响应粘住 */
function brandUrl(prefix: "logo" | "hero", brand: BrandCompose): string {
  const base = `/brand/${prefix}`;
  return brand.scheduled && brand.file ? `${base}?file=${encodeURIComponent(brand.file)}` : base;
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
