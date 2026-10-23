import Link from "next/link";
import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { checkPermission } from "@/lib/authz/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "后台" };

/** 后台门禁布局：site.admin 总开关；非 admin 直接 404（不暴露后台存在） */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const r = await checkPermission(user.id, "site.admin");
  if (!r.allowed) notFound();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <h1 className="text-xl font-bold tracking-tight">后台管理</h1>
        <nav className="flex gap-4 text-sm">
          <Link href="/admin/authz" className="hover:text-primary">
            角色与授权
          </Link>
          <Link href="/" className="text-muted-foreground hover:text-primary">
            ← 返回社区
          </Link>
        </nav>
      </header>
      {children}
    </div>
  );
}
