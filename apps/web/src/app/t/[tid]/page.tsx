import { ArrowLeft, Clock, Eye, MessageSquare, Paperclip, XCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pagination } from "@/components/content/pagination";
import { PostBody } from "@/components/content/post-body";
import { UserBadge } from "@/components/content/user-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getCurrentSubject } from "@/lib/authz/subject";
import { fileUrl } from "@/lib/files";
import { getForumView } from "@/lib/queries/forums";
import { getAttachments, getParentFloors, listReplies, pageOfFloor } from "@/lib/queries/posts";
import { getCurrentThreadView } from "@/lib/queries/threads";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ tid: string }>; searchParams: Promise<{ page?: string }> };

const parseTid = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const tid = parseTid((await params).tid);
  // 与页面共用同一份带权限的加载结果：不可见的主题在这里同样是 null，标题不会经 <title> 泄露
  const thread = tid ? await getCurrentThreadView(tid) : null;
  return { title: thread?.title ?? "帖子" };
}

export default async function ThreadPage({ params, searchParams }: Params) {
  const tid = parseTid((await params).tid);
  if (!tid) notFound();
  const { page: pageRaw } = await searchParams;

  const viewer = await getCurrentSubject();
  // 不存在 / 版块读不到 / 屏蔽或删除（非版主）/ 别人的待审核 → 一律 404，不暴露存在性
  const thread = await getCurrentThreadView(tid);
  if (!thread) notFound();

  const [forum, replies] = await Promise.all([
    getForumView(viewer, thread.forumId),
    listReplies(viewer, thread, Math.max(1, Number(pageRaw ?? "1") || 1)),
  ]);
  const [attachments, parents] = await Promise.all([
    getAttachments([thread.first.id, ...replies.items.map((r) => r.id)]),
    getParentFloors(
      thread.id,
      replies.items.flatMap((r) => (r.replyToPostId ? [r.replyToPostId] : [])),
    ),
  ]);

  const attachmentList = (postId: number) => {
    const list = attachments.get(postId) ?? [];
    if (list.length === 0) return null;
    return (
      <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
        <Paperclip className="size-4 text-muted-foreground" />
        {list.map((a) => (
          <a
            key={a.id}
            href={fileUrl(a.storageKey)}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
          >
            📎 {a.originalName}
            <span className="text-muted-foreground">（{a.downloads} 次下载）</span>
          </a>
        ))}
      </div>
    );
  };

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

      {thread.state === "pending" && (
        <p className="flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm text-info">
          <Clock className="size-4" /> 该主题正在审核中，目前只有你和版主能看到。
        </p>
      )}
      {thread.state === "rejected" && (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            该主题未通过审核，只有你和版主能看到。
            {thread.review?.note && <>驳回理由：{thread.review.note}</>}
          </span>
        </p>
      )}
      {(thread.state === "hidden" || thread.state === "deleted") && (
        <p className="rounded-lg border bg-muted px-3 py-2 text-sm text-muted-foreground">
          【版主视图】该主题已被{thread.state === "hidden" ? "隐藏" : "删除"}，普通用户看不到。
        </p>
      )}

      <header className="space-y-2">
        <h1 className="text-2xl leading-snug font-bold tracking-tight">
          {thread.prefixName && <span className="mr-2 text-primary">[{thread.prefixName}]</span>}
          {thread.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <UserBadge
            uid={thread.authorId}
            name={thread.authorName}
            deleted={thread.authorDeleted}
          />
          <span>{thread.createdAt}</span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3.5" />
            {thread.replyCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <Eye className="size-3.5" />
            {thread.viewCount}
          </span>
          {thread.isFeatured && (
            <Badge variant="outline" className="text-primary">
              精华
            </Badge>
          )}
          {thread.kind === "poll" && <Badge variant="outline">投票帖</Badge>}
        </div>
      </header>

      {/* 首帖（楼主）：每一页都固定在顶部 */}
      <Card id={`p${thread.first.id}`} className="scroll-mt-20">
        <CardContent className="pt-6">
          <PostBody md={thread.first.bodyMd} hasGate={thread.first.hasGate} />
          {attachmentList(thread.first.id)}
          {thread.first.editedAt && (
            <p className="mt-3 text-xs text-muted-foreground">最后编辑于 {thread.first.editedAt}</p>
          )}
        </CardContent>
      </Card>

      {/* 回帖楼层 */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          回帖 {replies.total} 条
          {replies.totalPages > 1 && ` · 第 ${replies.page}/${replies.totalPages} 页`}
        </h2>
        {replies.items.length === 0 && (
          <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
            暂无回帖，抢个沙发？
          </p>
        )}
        {replies.items.map((f) => {
          const parentFloor = f.replyToPostId ? parents.get(f.replyToPostId) : undefined;
          // 父帖在别的页时链接带页码；首帖（楼层 1）与本页内的帖子用页内锚点
          const parentHref =
            f.replyToPostId && parentFloor !== undefined
              ? parentFloor === 1 || pageOfFloor(parentFloor) === replies.page
                ? `#p${f.replyToPostId}`
                : `/t/${thread.id}?page=${pageOfFloor(parentFloor)}#p${f.replyToPostId}`
              : null;
          return (
            <Card key={f.id} id={`p${f.id}`} className="scroll-mt-20">
              <CardHeader className="flex flex-row items-center justify-between gap-2 py-3">
                <UserBadge uid={f.authorId} name={f.authorName} deleted={f.authorDeleted} />
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {f.state === "pending" && <Badge variant="outline">审核中</Badge>}
                  {f.state === "rejected" && <Badge variant="outline">已驳回</Badge>}
                  {(f.state === "hidden" || f.state === "deleted") && (
                    <Badge variant="outline">{f.state === "hidden" ? "已隐藏" : "已删除"}</Badge>
                  )}
                  #{f.floor}
                </span>
              </CardHeader>
              <CardContent className="space-y-2 pb-4">
                {parentHref && parentFloor !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    ↩ 回复{" "}
                    <a href={parentHref} className="text-primary hover:underline">
                      #{parentFloor}
                    </a>
                  </p>
                )}
                <PostBody md={f.bodyMd} hasGate={f.hasGate} />
                {attachmentList(f.id)}
                <p className="text-xs text-muted-foreground">
                  {f.createdAt}
                  {f.editedAt && ` · 编辑于 ${f.editedAt}`}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <Pagination basePath={`/t/${tid}`} page={replies.page} totalPages={replies.totalPages} />
    </main>
  );
}
