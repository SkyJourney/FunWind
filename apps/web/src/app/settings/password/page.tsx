import { eq } from "drizzle-orm";
import { getWebDb, users } from "@funwind/db";
import { getCurrentUser } from "@/lib/auth/session";
import { SubmitButton } from "@/components/ui/submit-button";
import { updatePasswordAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "账号安全" };

const inputCls =
  "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

/**
 * 改密码（M10.6c）：双轨强制换密与日常改密同一入口。
 * forced（?force=1 或账号 pending）= 免输当前密码（旧哈希已在登录时验过），页面常驻警示。
 */
export default async function PasswordSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ force?: string; saved?: string; error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) return null;
  const [row] = await getWebDb()
    .select({ legacyPending: users.legacyPasswordPending })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const sp = await searchParams;
  const forced = sp.force === "1" || row?.legacyPending === true;

  return (
    <div className="space-y-4">
      {forced && (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          你正在使用旧论坛密码登录。请设置新密码：完成后旧密码立即失效，全部其他设备将被退出。
          在此期间无法访问站内其他页面。
        </p>
      )}
      {sp.saved === "1" && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          新密码已生效；其他设备已退出登录。
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

      <form action={updatePasswordAction} className="space-y-3 rounded-xl border bg-card p-4">
        {!forced && (
          <label className="grid gap-1 text-sm">
            当前密码
            <input
              name="current"
              type="password"
              autoComplete="current-password"
              className={inputCls}
            />
          </label>
        )}
        <label className="grid gap-1 text-sm">
          新密码（至少 8 位）
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className={inputCls}
          />
        </label>
        <label className="grid gap-1 text-sm">
          确认新密码
          <input
            name="confirm"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className={inputCls}
          />
        </label>
        <div>
          <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
            设置新密码
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
