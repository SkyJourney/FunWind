import Link from "next/link";
import { Ticket } from "lucide-react";
import { requireAdmin } from "@/lib/authz/require-admin";
import { listInvitesPage } from "@/lib/admin/invites";
import { fmtDateTime } from "@/lib/admin/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { EmptyState } from "@/components/empty-state";
import { AdminFlash } from "@/components/admin/admin-flash";
import { CopyCode } from "@/components/admin/copy-code";
import { Pagination } from "@/components/content/pagination";
import { generateInvitesAction, revokeInviteAction, revokeInviteBatchAction } from "./actions";

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

const TABS = [
  { key: "all" as const, label: "全部" },
  { key: "available" as const, label: "可用" },
  { key: "used" as const, label: "已使用" },
  { key: "expired" as const, label: "已过期" },
];

/**
 * 邀请码管理（M10.6b；M9.5 重做）：状态页签 + 批次筛选 + 分页 + 新码高亮定位 + 一键复制 +
 * 按批次撤销可用码。消费侧 = 注册流（register.ts）零改动；撤销只删未用码，已用码保留作注册记录。
 */
export default async function InvitesAdminPage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: string;
    revoked?: string;
    err?: string;
    status?: string;
    batch?: string;
    page?: string;
  }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const sp = await searchParams;
  const status = TABS.some((t) => t.key === sp.status)
    ? (sp.status as "all" | "available" | "used" | "expired")
    : "all";
  const batch = typeof sp.batch === "string" ? sp.batch : "";
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  const { items, total } = await listInvitesPage({ status, batch, page });
  const totalPages = Math.max(1, Math.ceil(total / 20));

  const baseQuery = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    if (status !== "all") p.set("status", status);
    if (batch) p.set("batch", batch);
    for (const [k, v] of Object.entries(over)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return `/admin/invites${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-bold tracking-tight">邀请码</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          邀请制注册的入场券：一枚一用。撤销只对未使用的码生效；已使用的码保留为注册记录。
        </p>
      </header>

      {sp.saved && (
        <AdminFlash kind="success" dismissHref={baseQuery({ saved: "" })}>
          已生成 {sp.saved} 枚邀请码{batch ? `（批次「${batch}」，列表已按批次过滤）` : ""}，可用
          「复制」按钮逐枚发放。
        </AdminFlash>
      )}
      {sp.revoked && (
        <AdminFlash kind="success" dismissHref={baseQuery({ revoked: "" })}>
          已撤销批次「{batch}」的 {sp.revoked} 枚可用码。
        </AdminFlash>
      )}
      {sp.err && (
        <AdminFlash kind="error" dismissHref={baseQuery({ err: "" })}>
          {ERR_TEXT[sp.err] ?? "操作失败，请重试。"}
        </AdminFlash>
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

      {/* 状态页签 + 批次筛选 */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <nav className="flex gap-2" aria-label="邀请码状态">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={baseQuery({ status: t.key === "all" ? "" : t.key, page: "" })}
              className={`rounded-full border px-3 py-1 ${status === t.key ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <form action="/admin/invites" method="get" className="flex items-center gap-1.5">
          {status !== "all" && <input type="hidden" name="status" value={status} />}
          <input
            name="batch"
            defaultValue={batch}
            placeholder="批次关键词"
            className="w-36 rounded-lg border bg-background px-2.5 py-1.5 text-xs"
          />
          <button type="submit" className="rounded-lg border px-3 py-1.5 text-xs hover:bg-accent">
            筛选
          </button>
        </form>
        <span className="text-xs text-muted-foreground">共 {total} 枚</span>
        {batch && status !== "used" && status !== "expired" && (
          <form action={revokeInviteBatchAction} className="ml-auto">
            <input type="hidden" name="batch" value={batch} />
            <ConfirmSubmit
              title={`撤销批次「${batch}」的全部可用码？`}
              description="该批次已使用的码保留作注册记录，仅未使用的码会被删除。此操作不可恢复。"
              className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
              pendingText="…"
            >
              撤销本批次可用码
            </ConfirmSubmit>
          </form>
        )}
      </div>

      {/* 列表 */}
      {items.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title={total === 0 && !batch ? "还没有邀请码" : "没有匹配条件的邀请码"}
          description={
            total === 0 && !batch
              ? "用上方表单生成第一批邀请码，发给通过站内信/邮件联系到的人。"
              : undefined
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              第 {page}/{totalPages} 页
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {items.map((r) => {
              const badge = STATUS_BADGE[r.status];
              return (
                <div
                  key={r.code}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm ${
                    batch && r.batch === batch ? "ring-1 ring-primary" : ""
                  }`}
                >
                  <code className="font-mono text-[13px] tracking-wide">{r.code}</code>
                  {r.status === "available" && <CopyCode code={r.code} />}
                  <span className={`rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>{badge.text}</span>
                  {r.batch && (
                    <span className="text-xs text-muted-foreground">批次：{r.batch}</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {r.createdByName
                      ? `${r.createdByName} 创建于 ${fmtDateTime(r.createdAt)}`
                      : `创建于 ${fmtDateTime(r.createdAt)}`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.status === "used"
                      ? `${r.usedByName ?? "某用户"} · ${fmtDateTime(r.usedAt)}`
                      : r.expiresAt
                        ? `${fmtDateTime(r.expiresAt)} 过期`
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

      <Pagination basePath={baseQuery({})} page={page} totalPages={totalPages} />
    </div>
  );
}
