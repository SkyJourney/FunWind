import { eq } from "drizzle-orm";
import { getWebDb, userProfiles } from "@funwind/db";
import { getCurrentUser } from "@/lib/auth/session";
import { SubmitButton } from "@/components/ui/submit-button";
import { updateProfileAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "个人资料" };

const inputCls =
  "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

/** 个人资料（M10.6c）：userProfiles 可编辑字段；签名走 Markdown 净化渲染。 */
export default async function ProfileSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) return null;
  const [profile] = await getWebDb()
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, user.id))
    .limit(1);
  const sp = await searchParams;

  return (
    <div className="space-y-4">
      {sp.saved === "1" && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          资料已保存。
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
      <form action={updateProfileAction} className="space-y-3 rounded-xl border bg-card p-4">
        <label className="grid gap-1 text-sm">
          简介（{500} 字内）
          <textarea
            name="bio"
            rows={3}
            maxLength={500}
            defaultValue={profile?.bio ?? ""}
            className={inputCls}
          />
        </label>
        <label className="grid gap-1 text-sm">
          签名档（Markdown，展示于个人公开页）
          <textarea
            name="signature"
            rows={2}
            maxLength={200}
            defaultValue={profile?.signatureMd ?? ""}
            className={inputCls}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            坐标
            <input
              name="location"
              maxLength={100}
              defaultValue={profile?.location ?? ""}
              className={inputCls}
            />
          </label>
          <label className="grid gap-1 text-sm">
            主页（http(s):// 开头）
            <input
              name="website"
              maxLength={200}
              defaultValue={profile?.website ?? ""}
              className={inputCls}
            />
          </label>
          <label className="grid gap-1 text-sm">
            性别
            <select name="gender" defaultValue={String(profile?.gender ?? 0)} className={inputCls}>
              <option value="0">保密</option>
              <option value="1">男</option>
              <option value="2">女</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            生日
            <input
              name="birthday"
              type="date"
              defaultValue={profile?.birthday ?? ""}
              className={inputCls}
            />
          </label>
        </div>
        <div>
          <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
            保存资料
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
