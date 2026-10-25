import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getWebDb, posts, threads } from "@funwind/db";
import { hidePostAction } from "@/app/admin/review/actions";
import { ModerationForm } from "@/components/posting/moderation-form";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentSubject } from "@/lib/authz/subject";
import { checkPermission } from "@/lib/authz/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "屏蔽" };

type Params = {
  params: Promise<{ pid: string }>;
};

const parsePid = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * 屏蔽确认页（M9）：只有所辖版主能屏蔽 visible 内容；理由必填（写审计 + 通知作者）。
 */
export default async function HidePostPage({ params }: Params) {
  const pid = parsePid((await params).pid);
  if (!pid) notFound();
  const subject = await getCurrentSubject();
  if (subject.userId === null) notFound();

  const [row] = await getWebDb()
    .select({
      threadId: posts.threadId,
      state: posts.state,
      forumId: threads.forumId,
      title: threads.title,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(eq(posts.id, pid))
    .limit(1);
  if (!row || row.state !== "visible") notFound();
  const allowed = await checkPermission(subject, "forum.moderate", { forumId: row.forumId });
  if (!allowed.allowed) notFound();

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link
          href={`/t/${row.threadId}`}
          className="inline-flex items-center gap-1 hover:text-primary"
        >
          <ArrowLeft className="size-3.5" /> 返回主题
        </Link>
      </nav>
      <header>
        <h1 className="text-2xl font-bold tracking-tight">屏蔽内容</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          屏蔽后普通用户不可见（版主仍可见并可恢复）；作者会收到通知（含理由）。主题《{row.title}》
          {row.threadId === pid ? "（首帖将随主题一并屏蔽）" : ""}。
        </p>
      </header>
      <Card>
        <CardContent className="pt-6">
          <ModerationForm
            action={hidePostAction}
            postId={pid}
            reasonRequired
            submitLabel="屏蔽"
            destructive
          />
        </CardContent>
      </Card>
    </main>
  );
}
