import Link from "next/link";
import { Search, Wind } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import type { SessionUser } from "@/lib/auth/session";
import type { NavItem } from "@/lib/site-chrome";
import { MainNav, type NavLink } from "@/components/site/main-nav";
import { ThemeMenu } from "@/components/site/theme-menu";
import { UserMenu } from "@/components/site/user-menu";

/**
 * 品牌 LOGO（M10.5 LOGO 池定稿）：优先级 = 后台池当前项（/brand/logo，chrome 传入）
 * ＞ NEXT_PUBLIC_LOGO 静态素材（/logo 双档）＞ Wind 占位。
 * 尺寸：顶栏 36px；右栏品牌卡 96px（BrandCard）。
 */
const LOGO_BASE = process.env.NEXT_PUBLIC_LOGO ?? "";

/** 品牌图（池当前项/静态素材/回退占位）；size = 渲染边长 px。 */
export function BrandMark({
  size = 36,
  logoUrl,
}: {
  size?: 28 | 36 | 96;
  logoUrl?: string | null;
}) {
  const cls = size === 96 ? "size-24" : size === 36 ? "size-9" : "size-7";
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- 品牌位（/brand/logo 公开路由或本地静态素材），不经图片优化域
      <img src={logoUrl} alt="" width={size} height={size} className={`${cls} object-contain`} />
    );
  }
  if (LOGO_BASE) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- 品牌位固定素材（本地 /logo 双档），不经图片优化域
      <img
        src={`${LOGO_BASE}-${Math.min(112, size) < size ? 224 : 112}.png`}
        srcSet={`${LOGO_BASE}-112.png 1x, ${LOGO_BASE}-224.png 2x`}
        alt=""
        width={size}
        height={size}
        className={`${cls} object-contain`}
      />
    );
  }
  return (
    <span
      className={`${cls} flex items-center justify-center rounded-lg bg-primary text-primary-foreground`}
    >
      <Wind className={size === 96 ? "size-12" : size === 36 ? "size-5" : "size-4"} aria-hidden />
    </span>
  );
}

/** 右栏品牌卡（xl+）：大尺寸 LOGO 的正式展示位（96px + 站名 + slogan）。 */
export function BrandCard({
  logoUrl,
  siteName,
  tagline,
}: {
  logoUrl?: string | null;
  siteName: string;
  tagline: string;
}) {
  return (
    <section className="rounded-xl border bg-card p-5 text-center">
      <Link
        href="/"
        className="inline-flex flex-col items-center gap-2"
        aria-label={`${siteName} 首页`}
      >
        <BrandMark size={96} logoUrl={logoUrl} />
        <span className="text-lg font-bold tracking-tight">{siteName}</span>
        <span className="text-xs text-muted-foreground">{tagline}</span>
      </Link>
    </section>
  );
}

export function SiteHeader({
  user,
  chromeNav,
  siteName,
  notificationsOn,
  showAdmin,
  logoUrl,
  logoutAction,
}: {
  user: SessionUser | null;
  chromeNav: NavItem[];
  /** 站点身份（M10.6b）：chrome 可配名称，回退默认常量 */
  siteName: string;
  notificationsOn: boolean;
  showAdmin: boolean;
  /** LOGO 池当前项输出地址（/brand/logo）；null = 无池项（回退静态素材/占位） */
  logoUrl?: string | null;
  logoutAction: (formData: FormData) => Promise<void>;
}) {
  const navLinks: NavLink[] = [
    { label: "首页", href: "/", exact: true },
    { label: "版块", href: "/boards" },
    { label: "动态", href: "/follows" },
    ...chromeNav.map((n) => ({ label: n.label, href: n.href })),
  ];

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-3 sm:px-6 md:h-14">
        <Link
          href="/"
          aria-label={`${siteName} 首页`}
          className="flex min-w-0 shrink-0 items-center gap-2 font-semibold tracking-tight"
        >
          <BrandMark size={36} logoUrl={logoUrl} />
          {/* 站点名全端常显（M10.5 站长反馈：移动顶栏没有站点名） */}
          <span className="truncate text-[15px] md:text-base">{siteName}</span>
        </Link>
        <MainNav items={navLinks} className="hidden md:flex" />
        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          <Link
            href="/search"
            aria-label="搜索"
            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Search className="size-4" aria-hidden />
          </Link>
          {notificationsOn && <NotificationBell />}
          {/* 主题切换全端可用（M10.5 站长反馈：移动端看不到快速切主题入口） */}
          <ThemeMenu />
          {user ? (
            <UserMenu
              username={user.username}
              profileHref={`/u/${user.id}`}
              showAdmin={showAdmin}
              logoutAction={logoutAction}
            />
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                登录
              </Link>
              <Button asChild size="sm" className="hidden sm:inline-flex">
                <Link href="/register">注册</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
