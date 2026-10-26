import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { conversationMessages, openConversation } from "@/lib/pm/service";
import { otherMemberOf } from "@/lib/pm/queries";
import { sendMessageAction } from "@/app/actions/pm";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "对话" };

const pmErrorText: Record<string, string> = {
  login: "请先登录。",
  forbidden: "你没有发送私信的权限（可能被禁言）。",
  not_found: "对方不存在或已注销。",
  self: "不能给自己发私信。",
  reason_required: "内容不能为空。",
  quota_exceeded: "今日私信已达上限。",
};

/** 对话页（M10）：打开即已读（推进 last_read_message_id + 清理该会话未读通知行）；发送表单原生 form。 */
export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ convId: string }>;
  searchParams: Promise<{ pm?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const convId = Number((await params).convId);
  if (!Number.isInteger(convId) || convId <= 0) notFound();

  const ok = await openConversation(user.id, convId);
  if (!ok) notFound();

  const [messages, otherId] = await Promise.all([
    conversationMessages(convId),
    otherMemberOf(convId, user.id),
  ]);
  const sp = await searchParams;

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">
          {otherId ? (
            <Link href={`/u/${otherId}`} className="hover:text-primary">
              与 {user.id === otherId ? "自己" : "对方"}的对话
            </Link>
          ) : (
            "对话"
          )}
        </h1>
        <Link href="/messages" className="text-sm text-muted-foreground hover:text-primary">
          ← 会话列表
        </Link>
      </header>

      {sp.pm && pmErrorText[sp.pm] && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {pmErrorText[sp.pm]}
        </p>
      )}

      <Card>
        <CardContent className="space-y-3 pt-6">
          {messages.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">还没有消息。</p>
          ) : (
            <ul className="space-y-2">
              {messages.map((m) => {
                const mine = m.senderId === user.id;
                return (
                  <li key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                        mine ? "bg-primary text-primary-foreground" : "bg-muted"
                      }`}
                    >
                      <p className="break-words whitespace-pre-wrap">{m.body}</p>
                      <p
                        className={`mt-0.5 text-[10px] ${mine ? "opacity-70" : "text-muted-foreground"}`}
                      >
                        {m.createdAt}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {otherId && (
            <form action={sendMessageAction} className="flex items-end gap-2 border-t pt-3">
              <input type="hidden" name="recipientId" value={otherId} />
              <input type="hidden" name="back" value={`/messages/${convId}`} />
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
          )}
        </CardContent>
      </Card>
    </main>
  );
}
