import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { conversationList } from "@/lib/pm/queries";
import { sendMessageAction } from "@/app/actions/pm";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "私信" };

/** 私信会话列表（M10）：按最近消息倒序 + 每会话未读数；?to= 发起新会话。 */
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
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">私信</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          与其他会员的一对一对话。系统消息不走私信，在
          <Link href="/notifications?cat=message" className="mx-1 text-primary hover:underline">
            通知中心
          </Link>
          查看。
        </p>
      </header>

      {to !== null && to !== user.id && (
        <Card>
          <CardContent className="pt-6">
            <h2 className="mb-2 text-sm font-semibold">发起新会话</h2>
            <form action={sendMessageAction} className="flex items-end gap-2">
              <input type="hidden" name="recipientId" value={to} />
              <input type="hidden" name="back" value="/messages" />
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
        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          还没有私信。在用户资料页点「私信」开始对话。
        </p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {list.map((c) => (
            <li key={c.conversationId}>
              <Link
                href={`/messages/${c.conversationId}`}
                className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent/40"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {c.otherDeleted ? "已注销用户" : (c.otherName ?? "未知用户")}
                  </p>
                  <p className="text-xs text-muted-foreground">{c.lastMessageAt ?? "还没有消息"}</p>
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
