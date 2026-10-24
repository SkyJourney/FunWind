import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { restorePostAction } from "@/app/actions/posts";
import { ModerationForm } from "@/components/posting/moderation-form";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentSubject } from "@/lib/authz/subject";
import { postingNoticeText } from "@/lib/posting/compose";
import { loadRestorePage } from "@/lib/posting/moderation-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "恢复" };

type Params = {
  params: Promise<{ pid: string }>;
  searchParams: Promise<{ error?: string }>;
};

const parsePid = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * 恢复确认页（M6.2）。只有版主能恢复；作者或其他人一律 404。恢复必须填理由（写审计）。
 */
export default async function RestorePostPage({ params, searchParams }: Params) {
  const pid = parsePid((await params).pid);
  if (!pid) notFound();
  const { error } = await searchParams;

  const viewer = await getCurrentSubject();
  const model = await loadRestorePage(viewer, pid);
  if (model.kind === "notfound") notFound();

  const isThread = model.threadKind === "thread";
  const notice = postingNoticeText(error);

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link
          href={`/t/${model.threadId}`}
          className="inline-flex items-center gap-1 hover:text-primary"
        >
          <ArrowLeft className="size-3.5" /> 返回主题
        </Link>
      </nav>

      <header>
        <h1 className="text-2xl font-bold tracking-tight">{isThread ? "恢复主题" : "恢复回帖"}</h1>
      </header>

      {notice && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {notice}
        </p>
      )}

      <Card>
        <CardContent className="space-y-4 pt-6">
          <p className="text-sm text-muted-foreground">
            恢复后，内容会重新对有权查看的人可见。恢复须说明理由。
          </p>
          <ModerationForm
            action={restorePostAction}
            postId={model.postId}
            reasonRequired
            submitLabel={isThread ? "确认恢复主题" : "确认恢复回帖"}
          />
        </CardContent>
      </Card>
    </main>
  );
}
