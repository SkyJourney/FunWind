import { requireAdmin } from "@/lib/authz/require-admin";
import { getPointsName } from "@/lib/auth/settings";
import { getPointRewardConfig } from "@/lib/points/reward-load";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { adjustPointsAction, saveRewardAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "积分管理" };

const numField =
  "w-28 rounded-lg border bg-background px-3 py-1.5 text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring";

/** 积分管理（M7，admin.points）：奖励规则与显示名配置 + 手工调整。0 日上限 = 不限 */
export default async function AdminPointsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; adjusted?: string }>;
}) {
  await requireAdmin("admin.points");
  const sp = await searchParams;
  const [reward, pointsName] = await Promise.all([getPointRewardConfig(), getPointsName()]);

  return (
    <div className="space-y-6">
      {sp.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {sp.error}
        </p>
      )}
      {sp.saved && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          奖励规则已保存（变更已记入审计日志）。
        </p>
      )}
      {sp.adjusted && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          调整已入账（台账与审计各一条）。
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>奖励规则</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveRewardAction} className="space-y-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium">{pointsName}显示名</span>
              <input
                name="name"
                defaultValue={pointsName}
                className="w-56 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                maxLength={32}
                required
              />
            </label>
            <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
              <label className="space-y-1">
                <span className="block font-medium">发帖奖励</span>
                <input
                  name="post"
                  type="number"
                  defaultValue={reward.post}
                  min={0}
                  className={numField}
                />
              </label>
              <label className="space-y-1">
                <span className="block font-medium">发帖日上限（0=不限）</span>
                <input
                  name="postDailyCap"
                  type="number"
                  defaultValue={reward.postDailyCap}
                  min={0}
                  className={numField}
                />
              </label>
              <label className="space-y-1">
                <span className="block font-medium">回帖奖励</span>
                <input
                  name="reply"
                  type="number"
                  defaultValue={reward.reply}
                  min={0}
                  className={numField}
                />
              </label>
              <label className="space-y-1">
                <span className="block font-medium">回帖日上限（0=不限）</span>
                <input
                  name="replyDailyCap"
                  type="number"
                  defaultValue={reward.replyDailyCap}
                  min={0}
                  className={numField}
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              初值来自旧站实测（发帖 +3 / 回帖 +1，无日上限）。数值改动会记入审计日志。
            </p>
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              保存规则
            </button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>手工调整</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={adjustPointsAction} className="space-y-4">
            <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
              <label className="space-y-1">
                <span className="block font-medium">用户名</span>
                <input
                  name="username"
                  className="w-44 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                  required
                />
              </label>
              <label className="space-y-1">
                <span className="block font-medium">额度（正加负减）</span>
                <input name="delta" type="number" className={numField} required />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-sm font-medium">备注（必填，入台账与审计）</span>
              <input
                name="note"
                className="w-full max-w-xl rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                maxLength={200}
                required
              />
            </label>
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              执行调整
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
