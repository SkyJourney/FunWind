import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createThreadAction } from "@/app/actions/threads";
import { ThreadComposer } from "@/components/posting/thread-composer";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentSubject } from "@/lib/authz/subject";
import { limitsFor } from "@/lib/limits/load";
import { loadComposeAccess } from "@/lib/posting/compose-access";
import { postingNoticeText, REVIEW_HINT } from "@/lib/posting/compose";
import { getForumView } from "@/lib/queries/forums";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "发新主题" };

type Params = {
  params: Promise<{ fid: string }>;
  searchParams: Promise<{ error?: string }>;
};

const parseFid = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * 发新主题页（M6.2）。版块读不到 / 不存在 → 404（不暴露存在性）；能读但不能写 → 说明文字，不渲染表单。
 * 失败跳回（?error=…）时展示固定文案，并让草稿层恢复上次未发送的内容。
 */
export default async function NewThreadPage({ params, searchParams }: Params) {
  const fid = parseFid((await params).fid);
  if (!fid) notFound();
  const { error } = await searchParams;

  const viewer = await getCurrentSubject();
  const forum = await getForumView(viewer, fid);
  if (!forum) notFound();

  const [access, limits] = await Promise.all([
    loadComposeAccess(viewer, fid, forum.kind),
    limitsFor(viewer, fid),
  ]);
  const notice = postingNoticeText(error);

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="inline-flex items-center gap-1 hover:text-primary">
          <ArrowLeft className="size-3.5" /> 首页
        </Link>
        <span>/</span>
        <Link href={`/f/${forum.id}`} className="hover:text-primary">
          {forum.name}
        </Link>
      </nav>

      <header>
        <h1 className="text-2xl font-bold tracking-tight">发新主题</h1>
        <p className="mt-1 text-sm text-muted-foreground">在「{forum.name}」中发布</p>
      </header>

      {access.mode === "closed" ? (
        <Card>
          <CardContent className="space-y-3 pt-6 text-sm">
            <p>{access.text}</p>
            {access.loginHref && (
              <Link href={access.loginHref} className="text-primary hover:underline">
                去登录
              </Link>
            )}
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
          {access.reviewHint && (
            <p className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm text-info">
              {REVIEW_HINT}
            </p>
          )}
          <Card>
            <CardContent className="pt-6">
              <ThreadComposer
                action={createThreadAction}
                forumId={forum.id}
                draftKey={`funwind:draft:thread:${viewer.userId ?? "guest"}:${forum.id}`}
                restore={error !== undefined}
                titleMax={limits.titleMax}
                bodyMax={limits.bodyMax}
              />
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
