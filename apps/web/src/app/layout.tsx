import type { Metadata } from "next";
import Link from "next/link";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { logoutAction } from "@/app/actions/auth";
import { LogoutForm } from "@/components/auth/logout-form";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { AnnouncementBanner } from "@/components/site/announcement-banner";
import { getEnabledModuleIds } from "@/modules/kernel/state";
import { getCurrentUser } from "@/lib/auth/session";
import { bannerAnnouncement, getSiteChrome } from "@/lib/site-chrome";
// 模块注册表求值（注册 + 封板）：任何内核调用前加载
import "@/modules";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "FunWind · 青翼字幕组", template: "%s · FunWind" },
  description: "青翼字幕组新论坛——现代、轻主题、移动优先的 ACG 情怀社区。",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  // 通知模块停用时铃铛不渲染（模块装卸语义；读取契约对停用模块的存量数据无意义）
  const notificationsOn = user !== null && (await getEnabledModuleIds()).has("notifications");
  const [chrome, banner] = await Promise.all([getSiteChrome(), bannerAnnouncement(user !== null)]);

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
          <header className="border-b">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <Link href="/" className="font-semibold tracking-tight hover:text-primary">
                  青翼字幕组
                </Link>
                {/* 站点导航（管理可配；空则不渲染） */}
                <nav className="flex flex-wrap items-center gap-3 text-sm" aria-label="站点导航">
                  {chrome.nav.map((n) => (
                    <Link
                      key={`${n.label}:${n.href}`}
                      href={n.href}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {n.label}
                    </Link>
                  ))}
                  <Link href="/search" className="text-muted-foreground hover:text-foreground">
                    搜索
                  </Link>
                </nav>
              </div>
              <div className="flex items-center gap-3 text-sm">
                {user ? (
                  <>
                    {notificationsOn && <NotificationBell />}
                    <Link href={`/u/${user.id}`} className="font-medium hover:text-primary">
                      {user.username}
                    </Link>
                    <Link href="/points" className="text-muted-foreground hover:text-foreground">
                      积分
                    </Link>
                    <Link href="/follows" className="text-muted-foreground hover:text-foreground">
                      动态
                    </Link>
                    <Link
                      href="/settings/avatar"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      头像
                    </Link>
                    <LogoutForm action={logoutAction}>
                      <button type="submit" className="text-muted-foreground hover:text-foreground">
                        退出
                      </button>
                    </LogoutForm>
                  </>
                ) : (
                  <>
                    <Link href="/login" className="hover:text-primary">
                      登录
                    </Link>
                    <Link
                      href="/register"
                      className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90"
                    >
                      注册
                    </Link>
                  </>
                )}
              </div>
            </div>
          </header>
          {children}
          {chrome.links.length > 0 && (
            <footer className="mt-12 border-t py-6">
              <div className="mx-auto max-w-5xl space-y-2 px-4 sm:px-6 lg:px-8">
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
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
