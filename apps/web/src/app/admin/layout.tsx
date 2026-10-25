import Link from "next/link";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { getCurrentSubject } from "@/lib/authz/subject";
import { requireAdmin } from "@/lib/authz/require-admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "后台" };

/**
 * 后台门禁布局：site.admin 总开关；非 admin 直接 404（不暴露后台存在）。
 * 注意这只是第一道门：局部渲染可能跳过 layout，每个页面与 Server Action 仍须自己 requireAdmin。
 * 菜单可见性按权限集派生（不建菜单权限表）：站点级菜单看对应 admin.* 权限点；
 * 「内容审核」对版主开放（forum.moderate 作用域，队列内只显示所辖版块）。
 */

interface NavEntry {
  href: string;
  label: string;
  /** 需要的后台权限点；版主可达的项用 moderate 标记 */
  need:
    | {
        admin:
          | "admin.roles"
          | "admin.points"
          | "admin.badges"
          | "admin.users"
          | "admin.reports"
          | "admin.logs"
          | "admin.recycle";
      }
    | { moderate: true };
}

const NAV: NavEntry[] = [
  { href: "/admin/dashboard", label: "看板", need: { admin: "admin.logs" } },
  { href: "/admin/review", label: "内容审核", need: { moderate: true } },
  { href: "/admin/reports", label: "举报处理", need: { admin: "admin.reports" } },
  { href: "/admin/users", label: "用户管理", need: { admin: "admin.users" } },
  { href: "/admin/authz", label: "角色与授权", need: { admin: "admin.roles" } },
  { href: "/admin/points", label: "积分", need: { admin: "admin.points" } },
  { href: "/admin/badges", label: "徽章", need: { admin: "admin.badges" } },
  { href: "/admin/announcements", label: "公告", need: { moderate: true } },
  { href: "/admin/logs", label: "审计日志", need: { admin: "admin.logs" } },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  const subject = await getCurrentSubject();

  // 菜单可见性按权限集派生（站点级 admin.* 或版主身份）
  const visible = await Promise.all(
    NAV.map(async (entry) => {
      if ("admin" in entry.need) {
        return (await checkPermission(subject, entry.need.admin)).allowed ? entry : null;
      }
      // 版主可达：持有任一版块的 forum.moderate（scoped 授权必须数版主版块，不能裸 evaluate 全局）
      return (await getModeratedForumIds(subject)).length > 0 ? entry : null;
    }),
  );
  const items = visible.filter((e): e is NavEntry => e !== null);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 border-b pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-tight">后台管理</h1>
          <Link href="/" className="text-sm text-muted-foreground hover:text-primary">
            ← 返回社区
          </Link>
        </div>
        {/* 移动端：横向滚动条；桌面（md+）：一行铺开。侧边栏形态留给 M10.5 视觉打磨 */}
        <nav className="mt-3 flex gap-4 overflow-x-auto text-sm" aria-label="后台导航">
          {items.map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              className="whitespace-nowrap hover:text-primary"
            >
              {entry.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}
