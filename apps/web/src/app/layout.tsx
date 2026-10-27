import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { logoutAction } from "@/app/actions/auth";
import { BottomTabBar } from "@/components/site/bottom-tab-bar";
import { SiteHeader } from "@/components/site/site-header";
import { AnnouncementBanner } from "@/components/site/announcement-banner";
import { NavKindCapture } from "@/components/site/nav-kind-capture";
import { getEnabledModuleIds } from "@/modules/kernel/state";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentSubject } from "@/lib/authz/subject";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { unreadPmTotal } from "@/lib/pm/queries";
import { bannerAnnouncement, getSiteChrome } from "@/lib/site-chrome";
// 模块注册表求值（注册 + 封板）：任何内核调用前加载
import "@/modules";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "FunWind · 青翼字幕组", template: "%s · FunWind" },
  description: "青翼字幕组新论坛——现代、轻主题、移动优先的 ACG 情怀社区。",
};

export const viewport: Viewport = {
  // 移动端探测三件套：缺 width=device-width 时手机按 ~980px 桌面视口渲染整页缩小（S5-B 修复）
  width: "device-width",
  initialScale: 1,
  // iOS 刘海屏：允许内容延伸到安全区，底部 Tab 自行让位（env(safe-area-inset-bottom)）
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  // 模块停用时不渲染对应入口（模块装卸语义）；游客一律不算
  const enabled = user !== null ? await getEnabledModuleIds() : null;
  const notificationsOn = enabled?.has("notifications") ?? false;
  const pmOn = enabled?.has("pm") ?? false;
  const [chrome, banner, pmUnread, showAdmin] = await Promise.all([
    getSiteChrome(),
    bannerAnnouncement(user !== null),
    pmOn && user ? unreadPmTotal(user.id) : Promise.resolve(0),
    user !== null
      ? (async () => {
          // 「管理后台」入口可见性：站点管理员或任一版块版主（与 /admin 布局门禁同口径）
          const subject = await getCurrentSubject();
          const [siteAdmin, moderated] = await Promise.all([
            checkPermission(subject, "site.admin"),
            getModeratedForumIds(subject),
          ]);
          return siteAdmin.allowed || moderated.length > 0;
        })()
      : Promise.resolve(false),
  ]);

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="bg-background font-sans text-foreground antialiased">
        <ThemeProvider
          attribute="data-theme"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AnnouncementBanner banner={banner} />
          <NavKindCapture />
          <SiteHeader
            user={user}
            chromeNav={chrome.nav}
            notificationsOn={notificationsOn}
            showAdmin={showAdmin}
            logoUrl={chrome.logoActive ? "/brand/logo" : null}
            logoutAction={logoutAction}
          />
          {children}
          {/* 移动端底部 Tab 占位：内容不被固定栏遮挡 */}
          <div aria-hidden className="h-16 md:hidden" />
          {chrome.links.length > 0 && (
            <footer className="border-t py-6">
              <div className="mx-auto max-w-6xl space-y-2 px-4 sm:px-6 lg:px-8">
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">友情链接</span>
                  {chrome.links.map((l) => (
                    <a
                      key={`${l.label}:${l.href}`}
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-primary"
                      title={l.description}
                    >
                      {l.label}
                    </a>
                  ))}
                </p>
                {chrome.footerText && (
                  <p className="text-xs text-muted-foreground">{chrome.footerText}</p>
                )}
              </div>
            </footer>
          )}
          <BottomTabBar user={user ? { id: user.id } : null} pmOn={pmOn} pmUnread={pmUnread} />
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
