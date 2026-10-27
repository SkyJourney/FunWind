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
 * 品牌 LOGO（M10.5 视效试用）：NEXT_PUBLIC_LOGO 填 /logo/ 下文件名（不含尺寸后缀与扩展名）
 * 时渲染图片素材（112/224 双档，srcSet 视网膜自适应），否则回退 Wind 图标占位。
 * 正式机制 = LOGO 池后台管理（docs/LOGO-POOL.md，S5 阶段 C），届时由此处改为读 site_settings。
 */
const LOGO_BASE = process.env.NEXT_PUBLIC_LOGO ?? "";

export function SiteHeader({
  user,
  chromeNav,
  notificationsOn,
  showAdmin,
  logoutAction,
}: {
  user: SessionUser | null;
  chromeNav: NavItem[];
  notificationsOn: boolean;
  showAdmin: boolean;
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
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
        <Link
          href="/"
          aria-label="青翼字幕组 首页"
          className="flex shrink-0 items-center gap-2 font-semibold tracking-tight"
        >
          {LOGO_BASE ? (
            // eslint-disable-next-line @next/next/no-img-element -- 品牌位固定素材（本地 /logo 双档），不经图片优化域
            <img
              src={`${LOGO_BASE}-112.png`}
              srcSet={`${LOGO_BASE}-112.png 1x, ${LOGO_BASE}-224.png 2x`}
              alt=""
              width={28}
              height={28}
              className="size-7 rounded-lg object-contain"
            />
          ) : (
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Wind className="size-4" aria-hidden />
            </span>
          )}
          <span className="hidden sm:inline">青翼字幕组</span>
        </Link>
        <MainNav items={navLinks} className="hidden md:flex" />
        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          <Link
            href="/search"
            aria-label="搜索"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Search className="size-4" aria-hidden />
          </Link>
          {notificationsOn && <NotificationBell />}
          <div className="hidden sm:block">
            <ThemeMenu />
          </div>
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
