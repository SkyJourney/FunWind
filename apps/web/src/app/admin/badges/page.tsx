import { requireAdmin } from "@/lib/authz/require-admin";
import { badgeDictionary, userBadgesOf } from "@/lib/badges/service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { grantBadgeAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "荣誉徽章" };

const inputCls =
  "rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

/** 荣誉徽章授予（M7，admin.badges）：字典展示 + 按用户名手动授予（写审计，badge.awarded 事件） */
export default async function AdminBadgesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; granted?: string; uid?: string }>;
}) {
  await requireAdmin("admin.badges");
  const sp = await searchParams;
  const dictionary = await badgeDictionary();
  const uid = sp.uid !== undefined && /^\d+$/.test(sp.uid) ? Number(sp.uid) : null;
  const lastHolder = uid !== null ? await userBadgesOf(uid) : null;

  return (
    <div className="space-y-6">
      {sp.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {sp.error}
        </p>
      )}
      {sp.granted && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          已授予（审计与事件各一条）。
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>授予徽章</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={grantBadgeAction} className="flex flex-wrap items-end gap-4">
            <label className="space-y-1 text-sm">
              <span className="block font-medium">用户名</span>
              <input name="username" className={`${inputCls} w-44`} required />
            </label>
            <label className="space-y-1 text-sm">
              <span className="block font-medium">徽章</span>
              <select name="badgeId" className={`${inputCls} w-64`} required>
                {dictionary.map((b) => (
                  <option key={b.id} value={b.id}>
                    [{b.kind === "team" ? "团队" : "荣誉"}] {b.name}
                  </option>
                ))}
              </select>
            </label>
            <SubmitButton
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              pendingText="授予中…"
            >
              授予
            </SubmitButton>
          </form>
          {lastHolder !== null && (
            <p className="mt-3 text-xs text-muted-foreground">
              最近授予对象当前持有 {lastHolder.length} 枚徽章。
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>徽章字典（{dictionary.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {dictionary.map((b) => (
              <li key={b.id} className="rounded-lg border px-3 py-2 text-sm">
                <p className="font-medium">
                  <span className="mr-1 text-xs text-muted-foreground">
                    {b.kind === "team" ? "团队" : "荣誉"}
                  </span>
                  {b.name}
                </p>
                {b.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{b.description}</p>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
