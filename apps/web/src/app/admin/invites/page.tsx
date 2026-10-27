import { Ticket } from "lucide-react";
import { requireAdmin } from "@/lib/authz/require-admin";
import { listInvites } from "@/lib/admin/invites";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { EmptyState } from "@/components/empty-state";
import { generateInvitesAction, revokeInviteAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "邀请码" };

const ERR_TEXT: Record<string, string> = {
  not_found: "邀请码不存在（可能已被撤销），请刷新。",
  already_used: "该邀请码已被使用，不能撤销。",
};

const inputCls =
  "rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

const STATUS_BADGE = {
  available: { text: "可用", cls: "bg-success/10 text-success" },
  used: { text: "已使用", cls: "bg-muted text-muted-foreground" },
  expired: { text: "已过期", cls: "bg-warning/10 text-warning" },
} as const;

const fmtDate = (d: string | null): string =>
  d
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(
        new Date(d.replace(" ", "T")),
      )
    : "—";

/**
 * 邀请码管理（M10.6b）：批量生成（1–20 枚、有效天数、批次备注）、列表、撤销未用码。
 * 消费侧 = 注册流（register.ts）零改动；撤销只删未用码，已用码保留作注册记录。
 */
export default async function InvitesAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; err?: string }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const rows = await listInvites();
  const sp = await searchParams;

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-bold tracking-tight">邀请码</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          邀请制注册的入场券：一枚一用。撤销只对未使用的码生效；已使用的码保留为注册记录。
        </p>
      </header>

      {sp.saved === "1" && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          邀请码已生成，见下方列表（复制发放）。
        </p>
      )}
      {sp.err && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {ERR_TEXT[sp.err] ?? "操作失败，请重试。"}
        </p>
      )}

      {/* 生成 */}
      <Card>
        <CardContent className="pt-5">
          <form action={generateInvitesAction} className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              数量（1–20）
              <input
                name="count"
                type="number"
                min={1}
                max={20}
                defaultValue={5}
                required
                className={`${inputCls} w-28`}
              />
            </label>
            <label className="grid gap-1 text-sm">
              有效天数（0 = 永久）
              <input
                name="days"
                type="number"
                min={0}
                max={3650}
                defaultValue={30}
                className={`${inputCls} w-32`}
              />
            </label>
            <label className="grid gap-1 text-sm">
              批次备注
              <input
                name="batch"
                maxLength={64}
                placeholder="如：2026 春季召回"
                className={`${inputCls} w-52`}
              />
            </label>
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              生成
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      {/* 列表 */}
      {rows.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title="还没有邀请码"
          description="用上方表单生成第一批邀请码，发给通过站内信/邮件联系到的人。"
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>最近 100 枚</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {rows.map((r) => {
              const badge = STATUS_BADGE[r.status];
              return (
                <div
                  key={r.code}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm"
                >
                  <code className="font-mono text-[13px] tracking-wide">{r.code}</code>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>{badge.text}</span>
                  {r.batch && (
                    <span className="text-xs text-muted-foreground">批次：{r.batch}</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {r.createdByName
                      ? `${r.createdByName} 创建于 ${fmtDate(r.createdAt)}`
                      : `创建于 ${fmtDate(r.createdAt)}`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.status === "used"
                      ? `${r.usedByName ?? "某用户"} · ${fmtDate(r.usedAt)}`
                      : r.expiresAt
                        ? `${fmtDate(r.expiresAt)} 过期`
                        : "永不过期"}
                  </span>
                  {r.status === "available" && (
                    <form action={revokeInviteAction} className="ml-auto">
                      <input type="hidden" name="code" value={r.code} />
                      <ConfirmSubmit
                        title={`撤销 ${r.code}？`}
                        description="撤销后该码立即失效；此操作不可恢复。"
                        className="rounded-md border px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10"
                        pendingText="…"
                      >
                        撤销
                      </ConfirmSubmit>
                    </form>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
