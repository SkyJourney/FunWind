import Link from "next/link";
import { redirect } from "next/navigation";
import { MessageSquareOff } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { conversationList } from "@/lib/pm/queries";
import { sendMessageAction } from "@/app/actions/pm";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmptyState } from "@/components/empty-state";

export const dynamic = "force-dynamic";
export const metadata = { title: "私信" };

/**
 * 私信会话列表（M10 逻辑 + M10.5 视觉）：最近消息倒序 + 未读徽标 + 最后一条预览（「我：」前缀）。
 * 发起模型（站长定）：不设独立发起入口，从公开页/作者行/悬浮名片进入（?to= 为统一落点）。
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string; pm?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const list = await conversationList(user.id);
  const sp = await searchParams;
  const to = sp.to !== undefined && /^\d+$/.test(sp.to) ? Number(sp.to) : null;

  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">私信</h1>
        <p className="text-xs text-muted-foreground">
          在
          <Link href="/boards" className="mx-1 text-primary hover:underline">
            版块
          </Link>
          或他人主页点「✉ 私信」发起对话
        </p>
      </header>

      {sp.pm && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {sp.pm === "forbidden"
            ? "你没有发送私信的权限（可能被禁言）。"
            : sp.pm === "not_found"
              ? "对方不存在或已注销。"
              : sp.pm === "quota_exceeded"
                ? "今日私信已达上限。"
                : sp.pm === "reason_required"
                  ? "内容不能为空。"
                  : "发送失败，请稍后重试。"}
        </p>
      )}

      {to !== null && to !== user.id && (
        <Card>
          <CardContent className="pt-6">
            <h2 className="mb-2 text-sm font-semibold">发起新会话</h2>
            <form action={sendMessageAction} className="flex items-end gap-2">
              <input type="hidden" name="recipientId" value={to} />
              <input type="hidden" name="back" value={`/messages?to=${to}`} />
              <textarea
                name="body"
                rows={2}
                required
                maxLength={5000}
                placeholder="写点什么…（纯文本）"
                className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <SubmitButton
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                pendingText="发送中…"
              >
                发送
              </SubmitButton>
            </form>
          </CardContent>
        </Card>
      )}

      {list.length === 0 ? (
        <EmptyState
          icon={MessageSquareOff}
          title="还没有私信"
          description="在帖子作者或他人主页找到 TA，点「✉ 私信」就能开始对话"
          action="/boards"
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {list.map((c) => (
            <li key={c.conversationId}>
              <Link
                href={`/messages/${c.conversationId}`}
                className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-accent/40"
              >
                <Avatar size="default">
                  <AvatarFallback>{(c.otherName ?? "?").slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">
                      {c.otherDeleted ? "已注销用户" : (c.otherName ?? "未知用户")}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {c.lastMessageAt ?? ""}
                    </span>
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    {c.preview
                      ? `${c.preview.senderIsSelf ? "我：" : ""}${c.preview.body}`
                      : "还没有消息"}
                  </p>
                </div>
                {c.unread > 0 && (
                  <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                    {c.unread}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
