import { eq } from "drizzle-orm";
import { getWebDb, users } from "@funwind/db";
import { getCurrentUser } from "@/lib/auth/session";
import { SubmitButton } from "@/components/ui/submit-button";
import { updateEmailAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "邮箱" };

const inputCls =
  "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

/** 换绑邮箱（M10.6c）：需当前密码；换绑后验证态重置。 */
export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) return null;
  const [row] = await getWebDb()
    .select({ email: users.email, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const sp = await searchParams;

  return (
    <div className="space-y-4">
      {sp.saved === "1" && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          邮箱已更新（验证态已重置——找回密码 / 认领邮件将发往新邮箱）。
        </p>
      )}
      {sp.error && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {sp.error}
        </p>
      )}
      <p className="rounded-lg border bg-card px-3 py-2 text-sm">
        当前邮箱：
        <span className="font-medium">{row?.email ?? "未绑定"}</span>
        {row?.email &&
          (row.emailVerifiedAt ? (
            <span className="ml-1 text-xs text-success">已验证</span>
          ) : (
            <span className="ml-1 text-xs text-warning">未验证</span>
          ))}
      </p>
      <form action={updateEmailAction} className="space-y-3 rounded-xl border bg-card p-4">
        <label className="grid gap-1 text-sm">
          新邮箱
          <input name="email" type="email" required maxLength={254} className={inputCls} />
        </label>
        <label className="grid gap-1 text-sm">
          当前密码
          <input
            name="current"
            type="password"
            required
            autoComplete="current-password"
            className={inputCls}
          />
        </label>
        <div>
          <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
            更换邮箱
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
