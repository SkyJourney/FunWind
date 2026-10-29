import { notFound, redirect } from "next/navigation";
import { AdminShell, type AdminNavGroup } from "@/components/admin/admin-shell";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "后台" };

/**
 * 后台门禁布局：site.admin 总开关；非 admin 直接 404（不暴露后台存在）。
 * 注意这只是第一道门：局部渲染可能跳过 layout，每个页面与 Server Action 仍须自己 requireAdmin。
 * 菜单可见性按权限集派生（不建菜单权限表）：站点级菜单看对应 admin.* 权限点；
 * 「内容审核」对版主开放（forum.moderate 作用域，队列内只显示所辖版块）。
 * 布局壳（侧栏/抽屉/当前态）在 AdminShell；这里只做门禁与按权限过滤菜单。
 */

interface NavEntry {
  href: string;
  label: string;
  /** 需要的后台权限点；版主可达的项用 moderate 标记 */
  need:
    | {
        admin:
          | "site.admin"
          | "admin.roles"
          | "admin.points"
          | "admin.badges"
          | "admin.users"
          | "admin.reports"
          | "admin.logs"
          | "admin.recycle"
          | "emoji.manage";
      }
    | { moderate: true };
}

const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: "总览",
    items: [{ href: "/admin/dashboard", label: "看板", need: { admin: "admin.logs" } }],
  },
  {
    label: "内容",
    items: [
      { href: "/admin/review", label: "内容审核", need: { moderate: true } },
      { href: "/admin/contents", label: "内容管理", need: { moderate: true } },
      { href: "/admin/reports", label: "举报处理", need: { admin: "admin.reports" } },
      { href: "/admin/poll", label: "投票管理", need: { moderate: true } },
      { href: "/admin/pm", label: "私信管理", need: { admin: "admin.logs" } },
    ],
  },
  {
    label: "用户",
    items: [
      { href: "/admin/users", label: "用户管理", need: { admin: "admin.users" } },
      { href: "/admin/authz", label: "角色与授权", need: { admin: "admin.roles" } },
    ],
  },
  {
    label: "系统",
    items: [
      { href: "/admin/announcements", label: "公告", need: { moderate: true } },
      { href: "/admin/points", label: "积分", need: { admin: "admin.points" } },
      { href: "/admin/badges", label: "徽章", need: { admin: "admin.badges" } },
      { href: "/admin/logs", label: "审计日志", need: { admin: "admin.logs" } },
    ],
  },
  {
    label: "站点管理",
    items: [
      { href: "/admin/forums", label: "板块管理", need: { admin: "site.admin" } },
      { href: "/admin/emojis", label: "表情", need: { admin: "emoji.manage" } },
      { href: "/admin/settings", label: "站点配置", need: { admin: "site.admin" } },
      { href: "/admin/invites", label: "邀请码", need: { admin: "site.admin" } },
      { href: "/admin/logo", label: "LOGO 管理", need: { admin: "site.admin" } },
    ],
  },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // 总门：site.admin **或版主**（review 页版主可达；其它站点页各自 requireAdmin(perm) 二次拦截）
  const user = await getCurrentUser();
  if (!user) redirect("/login"); // 游客 → 登录页（与旧 requireAdmin 行为一致）
  const subject = await getCurrentSubject();
  const [siteAdmin, moderated] = await Promise.all([
    checkPermission(subject, "site.admin"),
    getModeratedForumIds(subject),
  ]);
  if (!siteAdmin.allowed && moderated.length === 0) notFound();

  const isModerator = moderated.length > 0;
  const groups: AdminNavGroup[] = [];
  for (const group of NAV_GROUPS) {
    const items = (
      await Promise.all(
        group.items.map(async (entry) => {
          if ("admin" in entry.need) {
            return (await checkPermission(subject, entry.need.admin)).allowed ? entry : null;
          }
          // 版主可达：持有任一版块的 forum.moderate（scoped 授权必须数版主版块，不能裸 evaluate 全局）
          return isModerator ? entry : null;
        }),
      )
    ).filter((e): e is NavEntry => e !== null);
    if (items.length > 0) {
      groups.push({ label: group.label, items: items.map(({ href, label }) => ({ href, label })) });
    }
  }

  return <AdminShell groups={groups}>{children}</AdminShell>;
}
