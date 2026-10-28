import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { pmStats, recentMessages } from "@/lib/pm/admin";
import { deleteMessageAction } from "./actions";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "私信管理" };

const parseUid = (raw: string | undefined): number | null =>
  raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;

/** 私信管理（M10 补做）：站点级权限（私信无板块作用域）——删除违规消息（审计）+ 按 uid 筛选。 */
export default async function AdminPmPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; deleted?: string; sender?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const senderFilter = parseUid(sp.sender);
  const all = await recentMessages(50);
  const items = senderFilter !== null ? all.filter((m) => m.senderId === senderFilter) : all;
  const stats = await pmStats();

  return (
    <div className="space-y-4">
      {sp.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {sp.error}
        </p>
      )}
      {sp.deleted && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          消息已删除（审计已记录）。
        </p>
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
      </div>

      <Card>
        <CardContent className="pt-6">
          <form action="/admin/pm" method="get" className="flex items-center gap-2">
            <input
              name="sender"
              defaultValue={sp.sender ?? ""}
              placeholder="按发送者 uid 筛选"
              className="w-44 rounded-lg border bg-background px-2.5 py-1.5 text-xs"
            />
            <button type="submit" className="rounded-lg border px-3 py-1.5 text-xs hover:bg-accent">
              筛选
            </button>
          </form>
        </CardContent>
      </Card>

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
                  · {m.createdAt} · 发送者 uid {m.senderId}
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
            没有消息。
          </li>
        )}
      </ul>
    </div>
  );
}
