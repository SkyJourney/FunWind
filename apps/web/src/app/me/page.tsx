import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  Bell,
  Coins,
  Heart,
  LogOut,
  MessageSquare,
  Palette,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { logoutAction } from "@/app/actions/auth";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentSubject } from "@/lib/authz/subject";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { fileUrl } from "@/lib/files";
import { unreadPmTotal } from "@/lib/pm/queries";
import { getProfile, getUserThreads } from "@/lib/queries/users";
import { unreadSummary } from "@/lib/notifications/queries";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LogoutForm } from "@/components/auth/logout-form";
import { ThreadRow } from "@/components/content/thread-row";

export const dynamic = "force-dynamic";
export const metadata = { title: "我的" };

const PM_POLICY_LABEL: Record<"all" | "following" | "off", string> = {
  all: "所有人",
  following: "仅我关注的人",
  off: "关闭私信",
};
const THEME_SHORT: Record<string, string> = { light: "浅色", dark: "暗色", system: "跟随系统" };

/**
 * 「我的」聚合页（M10.5 S5-B2，me.html 定稿，⟦D4⟧）：内容为主的中枢——
 * 身份/资产 + 我的内容 + 服务与偏好入口组（含私信权限、外观、管理入口）+ 退出。
 * 底部 Tab「我的」直达；桌面端与顶栏用户菜单指向同一组目的地。
 */
export default async function MePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const viewer = await getCurrentSubject();
  const [profile, pmUnread, notifUnread, threads, showAdmin] = await Promise.all([
    getProfile(user.id, viewer),
    unreadPmTotal(user.id),
    unreadSummary(user.id),
    getUserThreads(viewer, user.id, 1),
    (async () => {
      const [admin, moderated] = await Promise.all([
        checkPermission(viewer, "site.admin"),
        getModeratedForumIds(viewer),
      ]);
      return admin.allowed || moderated.length > 0;
    })(),
  ]);
  const pmPolicy: "all" | "following" | "off" = profile?.pmPolicy ?? "all";
  const themeCookie = (await cookies()).get("theme")?.value ?? "";
  const themeKey = ["light", "dark", "system"].includes(themeCookie) ? themeCookie : "system";

  const entryRow = (
    icon: React.ReactNode,
    label: string,
    href: string,
    badge?: number,
    hint?: string,
  ) => (
    <li>
      <Link
        href={href}
        className="flex items-center gap-3 border-b px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-accent/40"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </span>
        <span className="flex-1">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        {badge !== undefined && badge > 0 && (
          <span className="min-w-5 rounded-full bg-primary px-1.5 text-center text-xs leading-5 text-primary-foreground">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
        <span className="text-muted-foreground" aria-hidden>
          ›
        </span>
      </Link>
    </li>
  );

  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-8 sm:px-6">
      {/* 身份行 */}
      <header className="flex items-center gap-4">
        {profile?.avatarKey ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={fileUrl(profile.avatarKey)}
            alt=""
            width={56}
            height={56}
            className="rounded-xl border object-cover"
          />
        ) : (
          <Avatar className="size-14">
            <AvatarFallback className="text-lg">{user.username.slice(0, 1)}</AvatarFallback>
          </Avatar>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold tracking-tight">{user.username}</h1>
          <p className="text-xs text-muted-foreground">
            {profile?.followerCount ?? 0} 粉丝 · {profile?.threadCount ?? 0} 主题
          </p>
        </div>
        <Link
          href="/settings/avatar"
          className="rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
        >
          编辑
        </Link>
      </header>

      {/* 资产条 */}
      <div className="grid grid-cols-3 divide-x rounded-xl border bg-card text-center">
        <div className="py-3">
          <b className="text-[17px]">{profile?.points ?? 0}</b>
          <span className="block text-xs text-muted-foreground">
            {profile?.pointsName ?? "积分"}
          </span>
        </div>
        <div className="py-3">
          <b className="text-[17px]">{profile?.threadCount ?? 0}</b>
          <span className="block text-xs text-muted-foreground">主题</span>
        </div>
        <div className="py-3">
          <b className="text-[17px]">{profile?.featuredCount ?? 0}</b>
          <span className="block text-xs text-muted-foreground">精华</span>
        </div>
      </div>

      {/* 我的内容 */}
      <nav className="flex gap-0.5 rounded-lg bg-muted p-0.5 text-sm" aria-label="我的内容">
        <span className="flex-1 rounded-md bg-card px-3 py-1.5 text-center font-semibold shadow-1">
          我的主帖
        </span>
        <Link
          href={`/u/${user.id}?tab=replies`}
          className="flex-1 rounded-md px-3 py-1.5 text-center text-muted-foreground transition-colors hover:text-foreground"
        >
          我的回复
        </Link>
      </nav>
      {threads.items.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card/50 px-6 py-8 text-center text-sm text-muted-foreground">
          还没有发过主题——
          <Link href="/submit" className="text-primary hover:underline">
            去发第一帖
          </Link>
        </p>
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {threads.items.slice(0, 5).map((t) => (
            <div key={t.id} className="[&>div]:border-0">
              <ThreadRow thread={t} showForum />
            </div>
          ))}
        </div>
      )}
      {threads.items.length > 0 && (
        <p className="text-center text-sm">
          <Link href={`/u/${user.id}`} className="text-primary hover:underline">
            查看全部 →
          </Link>
        </p>
      )}

      {/* 服务 */}
      <h2 className="px-1 pt-2 text-xs font-semibold text-muted-foreground">服务</h2>
      <ul className="divide-y-0 rounded-xl border bg-card [&>li]:border-b [&>li]:last:border-b-0">
        {entryRow(<Heart className="size-4" aria-hidden />, "我的关注", "/follows")}
        {entryRow(
          <Coins className="size-4" aria-hidden />,
          "我的积分",
          "/points",
          undefined,
          String(profile?.points ?? 0),
        )}
        {entryRow(<MessageSquare className="size-4" aria-hidden />, "私信", "/messages", pmUnread)}
        {entryRow(
          <Bell className="size-4" aria-hidden />,
          "通知",
          "/notifications",
          notifUnread.total,
        )}
      </ul>

      {/* 偏好 */}
      <h2 className="px-1 pt-2 text-xs font-semibold text-muted-foreground">偏好</h2>
      <ul className="rounded-xl border bg-card">
        <li className="flex items-center gap-3 border-b px-4 py-3 text-sm">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <UserRound className="size-4" aria-hidden />
          </span>
          <span className="flex-1">头像与资料</span>
          <Link
            href="/settings/avatar"
            className="text-muted-foreground hover:text-primary"
            aria-label="头像设置"
          >
            ›
          </Link>
        </li>
        <li className="border-b px-4 py-3 text-sm">
          <Link
            href="/settings/pm"
            className="flex items-center gap-3 transition-colors hover:text-primary"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <MessageSquare className="size-4" aria-hidden />
            </span>
            <span className="flex-1">私信权限</span>
            <span className="text-xs text-muted-foreground">{PM_POLICY_LABEL[pmPolicy]}</span>
            <span aria-hidden className="text-muted-foreground">
              ›
            </span>
          </Link>
        </li>
        <li className="border-b px-4 py-3 text-sm">
          <Link
            href="/settings/appearance"
            className="flex items-center gap-3 transition-colors hover:text-primary"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Palette className="size-4" aria-hidden />
            </span>
            <span className="flex-1">外观</span>
            <span className="text-xs text-muted-foreground">
              {THEME_SHORT[themeKey] ?? "跟随系统"}
            </span>
            <span aria-hidden className="text-muted-foreground">
              ›
            </span>
          </Link>
        </li>
        {showAdmin &&
          entryRow(
            <ShieldCheck className="size-4" aria-hidden />,
            "管理后台",
            "/admin",
            undefined,
            "版主 / 管理员",
          )}
      </ul>

      <ul className="rounded-xl border bg-card">
        <li>
          <LogoutForm action={logoutAction}>
            <button
              type="submit"
              className="flex w-full items-center justify-center gap-2 px-4 py-3 text-sm font-medium text-destructive transition-colors hover:bg-accent/40"
            >
              <LogOut className="size-4" aria-hidden /> 退出登录
            </button>
          </LogoutForm>
        </li>
      </ul>
    </main>
  );
}
