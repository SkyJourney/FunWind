import type { Metadata } from "next";
import Link from "next/link";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { logoutAction } from "@/app/actions/auth";
import { LogoutForm } from "@/components/auth/logout-form";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { getCurrentUser } from "@/lib/auth/session";
// 模块注册表求值（注册 + 封板）：任何内核调用前加载
import "@/modules";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "FunWind · 青翼字幕组", template: "%s · FunWind" },
  description: "青翼字幕组新论坛——现代、轻主题、移动优先的 ACG 情怀社区。",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="bg-background font-sans text-foreground antialiased">
        <ThemeProvider
          attribute="data-theme"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <header className="border-b">
            <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
              <Link href="/" className="font-semibold tracking-tight hover:text-primary">
                青翼字幕组
              </Link>
              <div className="flex items-center gap-3 text-sm">
                {user ? (
                  <>
                    <NotificationBell />
                    <Link href={`/u/${user.id}`} className="font-medium hover:text-primary">
                      {user.username}
                    </Link>
                    <Link href="/points" className="text-muted-foreground hover:text-foreground">
                      积分
                    </Link>
                    <Link href="/follows" className="text-muted-foreground hover:text-foreground">
                      动态
                    </Link>
                    <Link href="/search" className="text-muted-foreground hover:text-foreground">
                      搜索
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
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
