import { Award } from "lucide-react";
import { requireAdmin } from "@/lib/authz/require-admin";
import { badgeDictionary, recentBadgeGrants, userBadgesOf } from "@/lib/badges/service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { EmptyState } from "@/components/empty-state";
import { AdminFlash } from "@/components/admin/admin-flash";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { UserPicker } from "@/components/admin/user-picker";
import { fmtDateTime } from "@/lib/admin/format";
import { grantBadgeAction, revokeBadgeAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "荣誉徽章" };

const inputCls =
  "rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

/** 荣誉徽章管理（M7；M9.5 重做）：授予带确认与 UserPicker、收回能力（审计+通知）、最近记录、字典空态。 */
export default async function AdminBadgesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; granted?: string; revoked?: string; uid?: string }>;
}) {
  await requireAdmin("admin.badges");
  const sp = await searchParams;
  const uid = sp.uid !== undefined && /^\d+$/.test(sp.uid) ? Number(sp.uid) : null;
  const [dictionary, lastHolder, recent] = await Promise.all([
    badgeDictionary(),
    uid !== null ? userBadgesOf(uid) : Promise.resolve(null),
    recentBadgeGrants(10),
  ]);

  return (
    <div className="space-y-6">
      {sp.error && (
        <AdminFlash kind="error" dismissHref="/admin/badges">
          {sp.error}
        </AdminFlash>
      )}
      {sp.granted && (
        <AdminFlash kind="success" dismissHref="/admin/badges">
          已授予（当事人会收到通知；审计与事件各一条）。
        </AdminFlash>
      )}
      {sp.revoked && (
        <AdminFlash kind="success" dismissHref="/admin/badges">
          已收回（当事人会收到通知；审计与事件各一条）。
        </AdminFlash>
      )}

      <Card>
        <CardHeader>
          <CardTitle>授予徽章</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={grantBadgeAction} className="flex flex-wrap items-end gap-4">
            <label className="space-y-1 text-sm">
              <span className="block font-medium">用户名</span>
              <UserPicker name="username" label="授予对象用户名" placeholder="用户名" required />
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
            <ConfirmSubmit
              title="授予徽章"
              description="确认对该用户授予所选徽章？当事人会收到通知。"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              pendingText="授予中…"
            >
              授予
            </ConfirmSubmit>
          </form>

          {/* 显式查询某人徽章（原 ?uid 只藏在授予回跳里） */}
          <div className="mt-4 border-t pt-3">
            <AdminFilterBar
              action="/admin/badges"
              resetHref="/admin/badges"
              keywordName="uid"
              placeholder="uid 查询某人徽章"
            />
          </div>
          {lastHolder !== null && (
            <div className="mt-2 text-xs text-muted-foreground">
              {lastHolder.length === 0 ? (
                <p>uid {uid} 当前没有徽章。</p>
              ) : (
                <p>
                  uid {uid} 当前持有 {lastHolder.length} 枚：
                </p>
              )}
              {lastHolder.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {lastHolder.map((b) => (
                    <li key={b.badgeId} className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        <span className="font-medium text-foreground">{b.name}</span>
                        <span className="ml-2">{fmtDateTime(b.awardedAt)} 授予</span>
                      </span>
                      <form action={revokeBadgeAction}>
                        <input type="hidden" name="uid" value={uid ?? ""} />
                        <input type="hidden" name="badgeId" value={b.badgeId} />
                        <ConfirmSubmit
                          title={`收回「${b.name}」？`}
                          description="确认收回该用户的此枚徽章？当事人会收到通知。"
                          className="rounded border px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10"
                          pendingText="…"
                        >
                          收回
                        </ConfirmSubmit>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>徽章字典（{dictionary.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {dictionary.length === 0 ? (
            <EmptyState
              icon={Award}
              title="徽章字典为空"
              description="字典由种子/迁移维护（badges 表）；字典为空时授予表单也无法选择徽章。"
            />
          ) : (
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
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>最近授予（{recent.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有授予记录。</p>
          ) : (
            <ul className="divide-y text-sm">
              {recent.map((r) => (
                <li
                  key={`${r.userId}:${r.badgeName}:${r.awardedAt}`}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span>
                    <span className="font-medium">{r.username ?? `uid ${r.userId}`}</span>
                    <span className="ml-2 text-muted-foreground">{r.badgeName}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{fmtDateTime(r.awardedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            收回/授予的完整操作者记录见审计日志（action = badge.grant / badge.revoke）。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
