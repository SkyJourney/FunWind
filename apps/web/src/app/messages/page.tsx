import Link from "next/link";
import { redirect } from "next/navigation";
import { MessageSquareOff } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { conversationPage } from "@/lib/pm/queries";
import { sendMessageAction } from "@/app/actions/pm";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConversationRow } from "@/components/messages/conversation-row";
import { ConversationStream } from "@/components/messages/conversation-stream";
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
  searchParams: Promise<{ to?: string; pm?: string; page?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  const page = Math.max(1, Math.trunc(Number(sp.page)) || 1);
  const { items: list, hasMore } = await conversationPage(user.id, page);
  const to = sp.to !== undefined && /^\d+$/.test(sp.to) ? Number(sp.to) : null;

  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">私信</h1>
        <p className="text-xs text-muted-foreground">
          在
          <Link href="/boards" className="mx-1 text-primary hover:underline">
            板块
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
                  : sp.pm === "pm_off"
                    ? "对方已关闭私信，无法发起新会话。"
                    : sp.pm === "pm_following"
                      ? "对方仅接受其关注的人的私信，请等待对方关注你后再发。"
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
          action={
            <Link
              href="/boards"
              className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              去板块逛逛
            </Link>
          }
        />
      ) : (
        <>
          {/* 直达 ?page=N 时从第 N 页起流式追加；往前翻仍走真链接 */}
          {page > 1 && (
            <Link
              href={page === 2 ? "/messages" : `/messages?page=${page - 1}`}
              className="block text-center text-sm text-muted-foreground hover:text-primary"
            >
              ← 上一页
            </Link>
          )}
          {/* M10.7 Step 3b：首屏服务端渲染（第 1 页前 10 行错落进场），后续页触底追加；无 JS 时底部是指向下一页的真链接 */}
          <ConversationStream
            endpoint="/api/stream/conversations"
            fallbackHref="/messages"
            startPage={page}
            hasMore={hasMore}
            seedIds={list.map((c) => c.conversationId)}
          >
            {list.map((c, index) => (
              <ConversationRow
                key={c.conversationId}
                conversation={c}
                className={page === 1 && index < 10 ? "fw-enter" : undefined}
                style={page === 1 && index < 10 ? { animationDelay: `${index * 50}ms` } : undefined}
              />
            ))}
          </ConversationStream>
        </>
      )}
    </main>
  );
}
