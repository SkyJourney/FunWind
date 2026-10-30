import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { openConversation } from "@/lib/pm/service";
import { messagesBefore, otherMemberOf, sentTodayCount } from "@/lib/pm/queries";
import { getCurrentSubject } from "@/lib/authz/subject";
import { findActiveGlobalBan } from "@/lib/authz/restrictions";
import { limitsFor } from "@/lib/limits/load";
import { sendMessageAction } from "@/app/actions/pm";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ChatHistory } from "@/components/messages/chat-history";
import { MessageBubble } from "@/components/messages/message-bubble";

export const dynamic = "force-dynamic";
export const metadata = { title: "对话" };

const pmErrorText: Record<string, string> = {
  login: "请先登录。",
  forbidden: "你没有发送私信的权限（可能被禁言）。",
  not_found: "对方不存在或已注销。",
  self: "不能给自己发私信。",
  reason_required: "内容不能为空。",
  quota_exceeded: "今日私信已达上限。",
  pm_off: "对方已关闭私信，无法发起新会话。",
  pm_following: "对方仅接受其关注的人的私信，请等待对方关注你后再发。",
};

/** 对话页（M10 逻辑 + M10.5 视觉）：打开即已读；气泡分组、额度提示、吸底输入区。 */
export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ convId: string }>;
  searchParams: Promise<{ pm?: string; before?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const convId = Number((await params).convId);
  if (!Number.isInteger(convId) || convId <= 0) notFound();

  const ok = await openConversation(user.id, convId);
  if (!ok) notFound();

  // 聊天默认展示**最新**一批消息（最新在底部）；`?before=<消息 id>` 查看更早的历史窗口（无 JS 的回退入口）
  const sp = await searchParams;
  const beforeRaw = Number(sp.before);
  const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
  const subject = await getCurrentSubject();
  const [batch, otherId, sentToday, limits] = await Promise.all([
    messagesBefore(convId, before),
    otherMemberOf(convId, user.id),
    sentTodayCount(user.id),
    limitsFor(subject),
  ]);
  const otherBanned = otherId !== null && (await findActiveGlobalBan(otherId)) !== null;
  const messages = batch.items;
  const perDay = limits.pmPerDay ?? 0;
  const remaining = perDay > 0 ? Math.max(0, perDay - sentToday) : null;

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-2xl flex-col px-4 sm:px-6">
      {/* 对话头（吸顶） */}
      <header className="sticky top-14 z-10 -mx-4 flex items-center gap-2.5 border-b bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <Link
          href="/messages"
          aria-label="返回会话列表"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          ←
        </Link>
        {otherId !== null ? (
          <Avatar size="sm">
            <AvatarFallback>{"?".slice(0, 1)}</AvatarFallback>
          </Avatar>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {otherId ? (
            <Link href={`/u/${otherId}`} className="hover:text-primary">
              对方的资料
            </Link>
          ) : (
            "对话"
          )}
        </h1>
      </header>

      {sp.pm && pmErrorText[sp.pm] && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {pmErrorText[sp.pm]}
        </p>
      )}

      {before !== null && (
        <p className="pt-2 text-center text-xs">
          <Link href={`/messages/${convId}`} className="text-primary hover:underline">
            回到最新消息 →
          </Link>
        </p>
      )}

      <div className="flex-1 space-y-3 py-4">
        <Card>
          <CardContent className="pt-6">
            {messages.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">还没有消息。</p>
            ) : (
              // M10.7 Step 3c：服务端渲染最新一批；上滑加载更早（无 JS 时顶部是「查看更早的消息」真链接）
              <ChatHistory
                convId={convId}
                viewerId={user.id}
                oldestId={messages[0]?.id ?? null}
                hasOlder={batch.hasMore}
                scrollToBottom={before === null}
                seedIds={messages.map((m) => m.id)}
              >
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} mine={m.senderId === user.id} />
                ))}
              </ChatHistory>
            )}
          </CardContent>
        </Card>
      </div>

      {otherId !== null && otherBanned && (
        <p className="py-3 text-center text-sm text-muted-foreground">该对话暂时只读。</p>
      )}

      {/* 输入区（吸底） */}
      {otherId !== null && !otherBanned && (
        <div className="sticky bottom-16 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 md:bottom-0">
          {remaining !== null && (
            <p
              className={`pb-2 text-right text-xs ${remaining <= 5 ? "text-warning" : "text-muted-foreground"}`}
            >
              今日还可发送 {remaining} / {perDay} 条
            </p>
          )}
          <form action={sendMessageAction} className="flex items-end gap-2">
            <input type="hidden" name="recipientId" value={otherId} />
            <input type="hidden" name="back" value={`/messages/${convId}`} />
            <textarea
              name="body"
              rows={2}
              required
              maxLength={5000}
              placeholder="写点什么…（纯文本）Enter 换行"
              className="flex-1 rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <SubmitButton
              className="rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              pendingText="发送中…"
            >
              发送
            </SubmitButton>
          </form>
        </div>
      )}
    </main>
  );
}
