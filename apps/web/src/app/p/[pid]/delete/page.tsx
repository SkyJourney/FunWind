import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deletePostAction } from "@/app/actions/posts";
import { ModerationForm } from "@/components/posting/moderation-form";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentSubject } from "@/lib/authz/subject";
import { postingNoticeText } from "@/lib/posting/compose";
import { loadDeletePage } from "@/lib/posting/moderation-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "删除" };

type Params = {
  params: Promise<{ pid: string }>;
  searchParams: Promise<{ error?: string }>;
};

const parsePid = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * 删除确认页（M6.2）。无权限 / 不存在 → 404；有权但当前不能删（有别人的回复、主题已隐藏或删除）→ 说明。
 * 删除主题后跳回板块列表；版主删别人的内容必须填理由，理由由服务端判定（空理由跳回并提示）。
 */
export default async function DeletePostPage({ params, searchParams }: Params) {
  const pid = parsePid((await params).pid);
  if (!pid) notFound();
  const { error } = await searchParams;

  const viewer = await getCurrentSubject();
  const model = await loadDeletePage(viewer, pid);
  if (model.kind === "notfound") notFound();

  const isThread = model.threadKind === "thread";
  const notice = postingNoticeText(error);

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link
          href={model.kind === "form" ? `/t/${model.threadId}` : "/"}
          className="inline-flex items-center gap-1 hover:text-primary"
        >
          <ArrowLeft className="size-3.5" /> 返回
        </Link>
      </nav>

      <header>
        <h1 className="text-2xl font-bold tracking-tight">{isThread ? "删除主题" : "删除回帖"}</h1>
      </header>

      {model.kind === "closed" ? (
        <Card>
          <CardContent className="pt-6 text-sm">
            <p>{model.text}</p>
          </CardContent>
        </Card>
      ) : (
        <>
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
                {isThread
                  ? "删除后，该主题会从板块列表中消失，只有版主能看到并恢复。"
                  : "删除后，该回帖对他人不可见，版主可以恢复。"}
              </p>
              <ModerationForm
                action={deletePostAction}
                postId={model.postId}
                reasonRequired={model.reasonRequired}
                submitLabel={isThread ? "确认删除主题" : "确认删除回帖"}
                destructive
              />
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
