import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { editPostAction } from "@/app/actions/posts";
import { EditComposer } from "@/components/posting/edit-composer";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentSubject } from "@/lib/authz/subject";
import { limitsFor } from "@/lib/limits/load";
import { postingNoticeText } from "@/lib/posting/compose";
import { loadEditPage } from "@/lib/posting/edit-page";
import { draftKey } from "@/components/editor/draft";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "编辑" };

type Params = {
  params: Promise<{ pid: string }>;
  searchParams: Promise<{ error?: string }>;
};

const parsePid = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * 编辑帖子页（M6.2）。不可见 / 无编辑权限 → 404；时限已过或主题已关闭 → 说明；门控数据读不全 → 明确告知，
 * 绝不带残缺正文渲染。失败跳回（?error=…）时展示固定文案，并恢复草稿；冲突时展示最新版本、不恢复草稿。
 */
export default async function EditPostPage({ params, searchParams }: Params) {
  const pid = parsePid((await params).pid);
  if (!pid) notFound();
  const { error } = await searchParams;

  const viewer = await getCurrentSubject();
  const model = await loadEditPage(viewer, pid);
  if (model.kind === "notfound") notFound();

  const notice = postingNoticeText(error);

  if (model.kind !== "form") {
    return (
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">编辑</h1>
        </header>
        <Card>
          <CardContent className="pt-6 text-sm">
            <p>{model.text}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  const limits = await limitsFor(viewer, model.forumId);
  const threadHref = `/t/${model.threadId}`;
  const isThread = model.threadKind === "thread";

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href={threadHref} className="inline-flex items-center gap-1 hover:text-primary">
          <ArrowLeft className="size-3.5" /> 返回主题
        </Link>
      </nav>

      <header>
        <h1 className="text-2xl font-bold tracking-tight">{isThread ? "编辑主题" : "编辑回帖"}</h1>
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
        <CardContent className="pt-6">
          <EditComposer
            action={editPostAction}
            postId={model.postId}
            threadKind={model.threadKind}
            title={model.title}
            source={model.source}
            editedAt={model.editedAt}
            reasonRequired={model.reasonRequired}
            resubmit={model.resubmit}
            reviewNote={model.reviewNote}
            forceSource={model.forceSource}
            forumId={model.forumId}
            initialAttachments={model.attachments}
            gateUnlocks={model.gateUnlocks}
            draftKey={draftKey(viewer.userId, "edit", model.postId)}
            restore={error !== undefined && error !== "conflict"}
            titleMax={limits.titleMax}
            bodyMax={limits.bodyMax}
          />
        </CardContent>
      </Card>
    </main>
  );
}
