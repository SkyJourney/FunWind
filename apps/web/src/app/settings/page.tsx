import Link from "next/link";
import { AtSign, Bell, KeyRound, ShieldCheck, UserRound } from "lucide-react";
import { eq } from "drizzle-orm";
import { getWebDb, users } from "@funwind/db";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "设置" };

const CARDS = [
  {
    href: "/settings/password",
    icon: KeyRound,
    title: "账号安全",
    desc: "修改登录密码；旧账号首次登录后请尽快更换新密码。",
  },
  {
    href: "/settings/email",
    icon: AtSign,
    title: "邮箱",
    desc: "更换绑定邮箱；用于找回密码与认领账号。",
  },
  {
    href: "/settings/profile",
    icon: UserRound,
    title: "个人资料",
    desc: "简介、签名、坐标、主页、生日与性别。",
  },
  {
    href: "/settings/notifications",
    icon: Bell,
    title: "通知偏好",
    desc: "选择哪些事件给你发站内通知。",
  },
];

/** 设置中心（M10.6c）：入口卡 + 账号状态摘要。 */
export default async function SettingsHubPage() {
  const user = await getCurrentUser();
  if (!user) return null; // layout 已兜底
  const [row] = await getWebDb()
    .select({
      username: users.username,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      legacyPending: users.legacyPasswordPending,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  return (
    <div className="space-y-4">
      <section className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 text-sm">
          <ShieldCheck className="size-4 text-primary" aria-hidden />
          <span className="font-medium">{row?.username}</span>
          <span className="text-muted-foreground">
            {row?.email
              ? row.emailVerifiedAt
                ? `邮箱 ${row.email}（已验证）`
                : `邮箱 ${row.email}（未验证——去「邮箱」页重新验证）`
              : "未绑定邮箱——建议绑定以便找回密码"}
          </span>
        </div>
        {row?.legacyPending && (
          <p className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
            你的账号仍在使用旧论坛密码——请立即更换为新密码（旧密码换完即失效）。
          </p>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-xl border bg-card p-4 transition-colors hover:bg-accent"
          >
            <c.icon className="size-5 text-primary" aria-hidden />
            <p className="mt-2 font-medium">{c.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{c.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
