import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { listPmMessagesPage, pmStats } from "@/lib/pm/admin";
import { deleteMessageAction } from "./actions";
import { fmtDateTime } from "@/lib/admin/format";
import { AdminFlash } from "@/components/admin/admin-flash";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { UserPicker } from "@/components/admin/user-picker";
import { Pagination } from "@/components/content/pagination";

export const dynamic = "force-dynamic";
export const metadata = { title: "私信管理" };

/** 私信管理（M10 补做；M9.5 重做）：筛选下推 SQL（uid 等值 / 用户名精确反查）+ 分页 + 统计缓存。 */
export default async function AdminPmPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; deleted?: string; q?: string; page?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  const [{ items, total, unknownUser }, stats] = await Promise.all([
    listPmMessagesPage({ q, page }),
    pmStats(),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / 20));

  const baseQuery = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    for (const [k, v] of Object.entries(over)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return `/admin/pm${qs ? `?${qs}` : ""}`;
  };

  const emptyText = unknownUser
    ? `没有名为「${q}」的用户（支持用户名精确匹配或数字 uid）。`
    : q
      ? `该发送者没有私信（或最近没有）。`
      : "还没有私信。";

  return (
    <div className="space-y-4">
      {sp.error && (
        <AdminFlash kind="error" dismissHref={baseQuery({ error: "" })}>
          {sp.error}
        </AdminFlash>
      )}
      {sp.deleted && (
        <AdminFlash kind="success" dismissHref={baseQuery({ deleted: "" })}>
          消息已删除（审计已记录）。
        </AdminFlash>
      )}

      <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
        <span>
          会话 <strong>{stats.conversations}</strong>
        </span>
        <span>
          消息 <strong>{stats.messages}</strong>
        </span>
        <span>
          今日 <strong>{stats.today}</strong>
        </span>
        <span className="self-center text-xs text-muted-foreground">（统计缓存 60 秒）</span>
      </div>

      <AdminFilterBar action="/admin/pm" resetHref="/admin/pm">
        {/* UserPicker 自带输入（name=q 与筛选参数对齐），datalist 提供候选 */}
        <UserPicker name="q" label="发送者筛选（用户名或 uid）" placeholder="发送者用户名 / uid" />
      </AdminFilterBar>

      <ul className="space-y-2">
        {items.map((m) => (
          <li key={m.id} className="rounded-xl border bg-card px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">
                  消息 #{m.id} · 会话{" "}
                  <Link
                    href={`/messages/${m.conversationId}`}
                    className="text-primary hover:underline"
                  >
                    {m.conversationId}
                  </Link>{" "}
                  · {fmtDateTime(m.createdAt)} · 发送者{" "}
                  {m.senderId === null ? "已注销用户" : `uid ${m.senderId}`}
                </p>
                <p className="mt-0.5 text-sm break-words whitespace-pre-wrap">{m.body}</p>
              </div>
              <form action={deleteMessageAction} className="flex shrink-0 items-center gap-1">
                <input type="hidden" name="messageId" value={m.id} />
                <input
                  name="reason"
                  required
                  maxLength={255}
                  placeholder="删除理由（必填）"
                  className="w-40 rounded-lg border bg-background px-2.5 py-1 text-xs"
                />
                <ConfirmSubmit
                  title="删除消息"
                  description="确认删除此消息？"
                  className="rounded-lg border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-60"
                  pendingText="…"
                >
                  删除
                </ConfirmSubmit>
              </form>
            </div>
          </li>
        ))}
        {items.length === 0 && (
          <li className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
            {emptyText}
          </li>
        )}
      </ul>

      <Pagination basePath={baseQuery({})} page={page} totalPages={totalPages} />
    </div>
  );
}
