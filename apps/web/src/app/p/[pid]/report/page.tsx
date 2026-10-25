import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getWebDb, posts, threads } from "@funwind/db";
import { reportPostAction } from "@/app/actions/reports";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentSubject } from "@/lib/authz/subject";
import { checkPermission } from "@/lib/authz/service";
import { postingNoticeText } from "@/lib/posting/compose";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "举报" };

type Params = {
  params: Promise<{ pid: string }>;
  searchParams: Promise<{ error?: string; done?: string }>;
};

const parsePid = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** 举报确认页（M9）：理由必填；同人同帖幂等（already 由服务层给出可读提示）。 */
export default async function ReportPostPage({ params, searchParams }: Params) {
  const pid = parsePid((await params).pid);
  if (!pid) notFound();
  const user = await getCurrentUser();
  if (!user) notFound();
  const subject = await getCurrentSubject();
  if (!(await checkPermission(subject, "forum.report")).allowed) notFound();

  const [row] = await getWebDb()
    .select({ threadId: posts.threadId, state: posts.state, title: threads.title })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(eq(posts.id, pid))
    .limit(1);
  if (!row || row.state !== "visible") notFound();

  const sp = await searchParams;

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
        <h1 className="text-2xl font-bold tracking-tight">举报内容</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          主题《{row.title}》的这条内容。举报会进入版主处理队列，处理结果将通知你。
        </p>
      </header>

      {sp.done ? (
        <Card>
          <CardContent className="pt-6 text-sm">
            <p className="font-medium text-success">已提交，感谢你的反馈。</p>
            <Link
              href={`/t/${row.threadId}`}
              className="mt-2 inline-block text-primary hover:underline"
            >
              返回主题
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6" id="form">
            {sp.error && (
              <p
                role="alert"
                className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
              >
                {postingNoticeText(sp.error) === "发布失败，请稍后重试。"
                  ? sp.error
                  : postingNoticeText(sp.error)}
              </p>
            )}
            <form action={reportPostAction} className="space-y-4">
              <input type="hidden" name="postId" value={pid} />
              <label htmlFor="report-reason" className="block space-y-1.5">
                <span className="text-sm font-medium">举报理由（必填）</span>
                <textarea
                  id="report-reason"
                  name="reason"
                  required
                  maxLength={255}
                  rows={4}
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder="说明违规情况（广告、人身攻击、违法内容等）"
                />
              </label>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                提交举报
              </button>
            </form>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
