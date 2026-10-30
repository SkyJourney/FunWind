import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getPasswordChangeUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/settings/password", label: "账号安全" },
  { href: "/settings/email", label: "邮箱" },
  { href: "/settings/profile", label: "个人资料" },
  { href: "/settings/notifications", label: "通知偏好" },
  { href: "/settings/pm", label: "私信偏好" },
  { href: "/settings/appearance", label: "外观" },
  { href: "/settings/avatar", label: "头像" },
];

/** 设置中心壳（M10.6c）：登录可见；子页各自做业务校验。 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const passwordChangeOnly = !user && Boolean(await getPasswordChangeUser());
  if (!user && !passwordChangeOnly) redirect("/login");
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-4">
        <h1 className="text-lg font-bold tracking-tight">
          {passwordChangeOnly ? "账号安全" : "设置"}
        </h1>
        {passwordChangeOnly ? (
          <p className="mt-2 text-sm text-warning">
            旧密码待更新。其他设置与普通登录功能暂不可用。
            <Link href="/settings/password?force=1" className="ml-2 underline">
              前往设置新密码
            </Link>
          </p>
        ) : (
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
        )}
      </header>
      {children}
    </main>
  );
}
