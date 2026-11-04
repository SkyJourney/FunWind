import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { Suspense } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { logoutAction } from "@/app/actions/auth";
import { BottomTabBar } from "@/components/site/bottom-tab-bar";
import { BottomSpacer } from "@/components/site/bottom-spacer";
import { SiteHeader } from "@/components/site/site-header";
import { AnnouncementBanner } from "@/components/site/announcement-banner";
import { NavKindCapture } from "@/components/site/nav-kind-capture";
import { NavigationGuard } from "@/components/site/navigation-guard";
import { getEnabledModuleIds } from "@/modules/kernel/state";
import { getCurrentUser } from "@/lib/auth/session";
import { avatarKeyOf } from "@/lib/queries/users";
import { fileUrl } from "@/lib/files";
import { getCurrentSubject } from "@/lib/authz/subject";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { unreadPmTotal } from "@/lib/pm/queries";
import { bannerAnnouncement, getSiteChrome, getSiteIdentity } from "@/lib/chrome/site-chrome";
import { getUserThemePack, resolveEffectivePack } from "@/lib/theme/pref";
import { getThemeCatalog, isKnownPackId } from "@/lib/theme/catalog";
import { cssTextForPack } from "@/lib/theme/surface-render";
import { themeSurfaceStyle } from "@/lib/theme/surface-style";
import { THEME_PREVIEW_COOKIE, verifyThemePreview } from "@/lib/theme/preview";
import { stopThemePreviewAction } from "@/app/theme-preview-actions";
import { QueryToast } from "@/components/feedback/query-toast";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";
// 模块注册表求值（注册 + 封板）：任何内核调用前加载
import "@/modules";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  // 站点身份可配（M10.6b）：chrome TTL 缓存内读取，后台改名下一请求生效
  const { name, tagline } = await getSiteIdentity();
  return {
    title: { default: name, template: `%s · ${name}` },
    description: tagline,
  };
}

export async function generateViewport(): Promise<Viewport> {
  const [chrome, catalog] = await Promise.all([getSiteChrome(), getThemeCatalog()]);
  const themeColor = catalog.find((pack) => pack.id === chrome.themePack)?.themeColor ?? "#0e7490";
  return {
    // 移动端探测三件套：缺 width=device-width 时手机按 ~980px 桌面视口渲染整页缩小（S5-B 修复）
    width: "device-width",
    initialScale: 1,
    // iOS 刘海屏：允许内容延伸到安全区，底部 Tab 自行让位（env(safe-area-inset-bottom)）
    viewportFit: "cover",
    themeColor,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const request = await headers();
  const user = await getCurrentUser();
  // 模块停用时不渲染对应入口（模块装卸语义）；游客一律不算
  const enabled = user !== null ? await getEnabledModuleIds() : null;
  const notificationsOn = enabled?.has("notifications") ?? false;
  const pmOn = enabled?.has("pm") ?? false;
  const [chrome, banner, pmUnread, showAdmin, avatarKey, userPack, catalog] = await Promise.all([
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
    // 顶栏头像（M10.6d 站长反馈：菜单里应显示头像图，无头像才回退首字母）
    user ? avatarKeyOf(user.id) : Promise.resolve(null),
    // 主题包偏好（M11）：登录用户读 profile；游客 null → 跟随站点默认
    user ? getUserThemePack(user.id) : Promise.resolve(null),
    getThemeCatalog(),
  ]);
  const avatarUrl = avatarKey ? fileUrl(avatarKey) : null;
  // 全站主题预览（M11.1 Step 7）：站长签名 cookie 10 分钟内按目标包渲染，不落库、不影响他人；
  // 失效/签名不过/包已停用 → 静默回正常链
  // 时间戳取自请求头 Date（缺失时回退 0 → 预览视为过期）；避免在渲染期调用 Date.now（React 纯度规则）
  const nowSec = Number(request.get("date") ?? 0) / 1000;
  const previewRaw = verifyThemePreview((await cookies()).get(THEME_PREVIEW_COOKIE)?.value, nowSec);
  const previewPack =
    previewRaw && user !== null && (await isKnownPackId(previewRaw)) ? previewRaw : null;
  // html[data-pack] 服务端直出（预览 → 用户偏好 → 站点默认 → default）：SSR 首帧即正确，无主题闪烁；
  // data-mode（明暗）仍由 next-themes 客户端脚本写入，两者正交（docs/THEME-SYSTEM.md §2）
  const themePack = previewPack ?? resolveEffectivePack(userPack, chrome.themePack);
  const packPref = user
    ? {
        user: userPack,
        site: chrome.themePack,
        options: catalog.map(({ id, label }) => ({ id, label })),
      }
    : null;
  // default 包定义作为所有数据包的缺省档兜底（回退链 包值 → default 包 → 内置 CSS）
  const defaultDefinition = catalog.find((pack) => pack.id === "default")?.definition ?? undefined;
  const themeStyles = catalog
    .flatMap((pack) =>
      pack.definition ? [cssTextForPack(pack.id, pack.definition, defaultDefinition)] : [],
    )
    .filter(Boolean)
    .join("\n");

  return (
    <html lang="zh-CN" data-pack={themePack} suppressHydrationWarning>
      <body
        data-surface="page"
        data-fw-theme-surface
        className="bg-transparent font-sans text-foreground antialiased"
        style={{
          ...themeSurfaceStyle("page", { background: "var(--background)" }),
          background: "transparent",
        }}
      >
        {themeStyles && (
          <style data-fw-theme-pack dangerouslySetInnerHTML={{ __html: themeStyles }} />
        )}
        {previewPack && (
          <div
            role="status"
            data-testid="theme-preview-banner"
            className="flex flex-wrap items-center justify-center gap-2 bg-warning/15 px-4 py-1.5 text-xs text-warning"
          >
            <span>正在全站预览主题包：{previewPack}（10 分钟内有效，仅本人可见，不写入配置）</span>
            <form action={stopThemePreviewAction}>
              <button
                type="submit"
                className="rounded border border-warning/50 px-2 py-0.5 hover:bg-warning/10"
              >
                退出预览
              </button>
            </form>
          </div>
        )}
        <ThemeProvider
          attribute="data-mode"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ServiceWorkerRegistration />
          <AnnouncementBanner banner={banner} />
          <NavKindCapture />
          <SiteHeader
            user={user}
            chromeNav={chrome.nav}
            siteName={chrome.identity.name}
            avatarUrl={avatarUrl}
            notificationsOn={notificationsOn}
            showAdmin={showAdmin}
            registrationOpen={chrome.registrationOpen}
            logoUrl={chrome.logoUrl}
            packPref={packPref}
            logoutAction={logoutAction}
          />
          {children}
          {/* 移动端底部 Tab 占位：内容不被固定栏遮挡；后台无底部 Tab，不占位 */}
          <BottomSpacer />
          {chrome.links.length > 0 && (
            <footer
              data-surface="footer"
              data-fw-theme-surface
              className="border-t bg-transparent py-6"
              style={themeSurfaceStyle("footer", {
                background: "var(--background)",
                borderColor: "var(--border)",
                borderWidth: "1px",
              })}
            >
              <div className="mx-auto max-w-6xl space-y-2 px-4 sm:px-6 lg:px-8">
                <p
                  data-surface-text="muted"
                  className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
                >
                  <span className="font-medium text-foreground">友情链接</span>
                  {chrome.links.map((l) => (
                    <a
                      key={`${l.label}:${l.href}`}
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-surface-text="link"
                      className="hover:text-primary"
                      title={l.description}
                    >
                      {l.label}
                    </a>
                  ))}
                </p>
                {chrome.footerText && (
                  <p data-surface-text="muted" className="text-xs text-muted-foreground">
                    {chrome.footerText}
                  </p>
                )}
              </div>
            </footer>
          )}
          <BottomTabBar user={user ? { id: user.id } : null} pmOn={pmOn} pmUnread={pmUnread} />
          <Suspense fallback={null}>
            <QueryToast />
            <NavigationGuard />
          </Suspense>
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
