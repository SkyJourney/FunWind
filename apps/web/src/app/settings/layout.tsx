import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/settings/password", label: "账号安全" },
  { href: "/settings/email", label: "邮箱" },
  { href: "/settings/profile", label: "个人资料" },
  { href: "/settings/notifications", label: "通知偏好" },
  { href: "/settings/avatar", label: "头像" },
  { href: "/me", label: "私信偏好 / 外观" },
];

/** 设置中心壳（M10.6c）：登录可见；子页各自做业务校验。 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-4">
        <h1 className="text-lg font-bold tracking-tight">设置</h1>
        <nav aria-label="设置导航" className="mt-2 flex flex-wrap gap-1.5 text-sm">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="rounded-lg border px-2.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </main>
  );
}
