import { ArrowLeft, Eye, MessageSquare, Paperclip } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pagination } from "@/components/content/pagination";
import { RichContent } from "@/components/content/rich-content";
import { UserBadge } from "@/components/content/user-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getThreadAttachments, listFloors } from "@/lib/queries/posts";
import { getThreadDetail } from "@/lib/queries/threads";
import { getCurrentUser } from "@/lib/auth/session";
import { checkPermission } from "@/lib/authz/service";
import { getForum } from "@/lib/queries/forums";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ tid: string }>; searchParams: Promise<{ page?: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { tid } = await params;
  const thread = await getThreadDetail(Number(tid));
  if (!thread || thread.isSpam) return { title: "帖子" };
  return { title: thread.title };
}

export default async function ThreadPage({ params, searchParams }: Params) {
  const { tid: tidRaw } = await params;
  const { page: pageRaw } = await searchParams;
  const tid = Number(tidRaw);
  if (!Number.isInteger(tid) || tid <= 0) notFound();

  const thread = await getThreadDetail(tid);
  // spam 空壳 / 不存在 → 404；屏蔽态保留 tid 语义走 blocked 视图
  if (!thread || thread.isSpam) notFound();

  // 版块读取权限（M5）：DENY 视为 404（不暴露受限版块存在性）
  const user = await getCurrentUser();
  const read = await checkPermission(user?.id ?? null, "forum.read", { forumId: thread.forumId });
  if (!read.allowed) notFound();

  const { items: floors, total, totalPages } = await listFloors(tid, Number(pageRaw ?? "1") || 1);
  const page = Math.min(Math.max(1, Number(pageRaw ?? "1") || 1), totalPages);
  const firstAttachments = await getThreadAttachments(tid);
  const forum = await getForum(thread.forumId);

  if (thread.status > 0) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">{thread.title}</h1>
        <p className="mt-4 text-sm text-muted-foreground">该内容已被屏蔽或审核中，暂不可查看。</p>
        <Link
          href={`/f/${thread.forumId}`}
          className="mt-6 inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="size-4" /> 返回版块
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="inline-flex items-center gap-1 hover:text-primary">
          <ArrowLeft className="size-3.5" /> 首页
        </Link>
        {forum && (
          <>
            <span>/</span>
            <Link href={`/f/${forum.id}`} className="hover:text-primary">
              {forum.name}
            </Link>
          </>
        )}
      </nav>

      <header className="space-y-2">
        <h1 className="text-2xl leading-snug font-bold tracking-tight">{thread.title}</h1>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <UserBadge
            name={thread.authorName}
            hint={thread.authorName ? undefined : "作者账号已注销"}
          />
          {thread.createdAt && <span>{thread.createdAt}</span>}
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3.5" />
            {thread.replyCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <Eye className="size-3.5" />
            {thread.viewCount}
          </span>
          {thread.digest > 0 && (
            <Badge variant="outline" className="text-primary">
              精华
            </Badge>
          )}
          {thread.special === "poll" && <Badge variant="outline">投票帖</Badge>}
        </div>
      </header>

      {/* 首帖（楼主） */}
      <Card>
        <CardContent className="pt-6">
          <RichContent md={thread.contentMd} />
          {firstAttachments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
              <Paperclip className="size-4 text-muted-foreground" />
              {firstAttachments.map((a) => (
                <a
                  key={a.id}
                  href={`/attachment/${a.path}`}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                >
                  📎 {a.filename}
                  <span className="text-muted-foreground">（{a.downloads} 次下载）</span>
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 回帖楼层 */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          回帖 {total} 条{totalPages > 1 && ` · 第 ${page}/${totalPages} 页`}
        </h2>
        {floors.length === 0 && (
          <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
            暂无回帖，抢个沙发？
          </p>
        )}
        {floors.map((f) => {
          const parent = f.replyToPid ? floors.find((x) => x.id === f.replyToPid) : undefined;
          return (
            <Card key={f.id} id={`p${f.id}`} className="scroll-mt-20">
              <CardHeader className="flex flex-row items-center justify-between gap-2 py-3">
                <UserBadge name={f.authorName} hint={f.authorName ? undefined : "作者账号已注销"} />
                <span className="text-xs text-muted-foreground">#{f.floor}</span>
              </CardHeader>
              <CardContent className="space-y-2 pb-4">
                {parent && (
                  <p className="text-xs text-muted-foreground">
                    ↩ 回复{" "}
                    <a href={`#p${parent.id}`} className="text-primary hover:underline">
                      #{parent.floor}
                    </a>
                  </p>
                )}
                <RichContent md={f.contentMd} />
                {f.createdAt && <p className="text-xs text-muted-foreground">{f.createdAt}</p>}
              </CardContent>
            </Card>
          );
        })}
      </section>

      <Pagination basePath={`/t/${tid}`} page={page} totalPages={totalPages} />
    </main>
  );
}
