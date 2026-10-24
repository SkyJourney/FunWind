import { ArrowLeft, Clock, Eye, MessageSquare, Paperclip, XCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pagination } from "@/components/content/pagination";
import { PostBody } from "@/components/content/post-body";
import { UserBadge } from "@/components/content/user-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getPointsName } from "@/lib/auth/settings";
import { checkPermission } from "@/lib/authz/service";
import { getCurrentSubject } from "@/lib/authz/subject";
import { listAttachments } from "@/lib/gates/attachments";
import { loadGateViews } from "@/lib/gates/service";
import { fileUrl } from "@/lib/files";
import { getForumView } from "@/lib/queries/forums";
import { getParentFloors, listReplies, pageOfFloor } from "@/lib/queries/posts";
import { getCurrentThreadView } from "@/lib/queries/threads";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ tid: string }>;
  searchParams: Promise<{ page?: string; gate?: string }>;
};

/** 购买失败的固定提示码（?gate=…）→ 文案。只认这几个码，URL 里的其它内容一律忽略 */
const GATE_NOTICES: Record<string, string> = {
  insufficient: "积分不足，无法解锁该内容。",
  own_content: "你是该内容的作者或版主，无需购买。",
  unavailable: "该内容暂不可购买。",
  rate: "操作过于频繁，请稍后再试。",
};

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
  const { page: pageRaw, gate: gateNotice } = await searchParams;

  const viewer = await getCurrentSubject();
  // 不存在 / 版块读不到 / 屏蔽或删除（非版主）/ 别人的待审核 → 一律 404，不暴露存在性
  const thread = await getCurrentThreadView(tid);
  if (!thread) notFound();

  const [forum, replies] = await Promise.all([
    getForumView(viewer, thread.forumId),
    listReplies(viewer, thread, Math.max(1, Number(pageRaw ?? "1") || 1)),
  ]);
  // 一页的全部门控一次解析：作者/版主/已解锁者拿到正文，其余人拿到锁卡片（锁卡片里没有正文）
  const gatePosts = [
    { id: thread.first.id, authorId: thread.authorId, hasGate: thread.first.hasGate },
    ...replies.items.map((r) => ({ id: r.id, authorId: r.authorId, hasGate: r.hasGate })),
  ];
  // 附件下载权限按版块判定，整页同属一个版块，只查一次；无权者看到附件名与原因，不渲染可点击链接（点进去只会是 404）
  const canDownload = (
    await checkPermission(viewer, "attachment.download", { forumId: thread.forumId })
  ).allowed;
  const [attachments, parents, gates, pointsName] = await Promise.all([
    // 门控附件与隐藏正文同权：锁定项只带「存在一个」，不含文件名 / 存储键 / 大小（lib/gates/attachments.ts）
    listAttachments(viewer, thread, gatePosts),
    getParentFloors(
      thread.id,
      replies.items.flatMap((r) => (r.replyToPostId ? [r.replyToPostId] : [])),
    ),
    loadGateViews(viewer, thread, gatePosts),
    getPointsName(),
  ]);

  const attachmentList = (postId: number) => {
    const list = attachments.get(postId) ?? [];
    if (list.length === 0) return null;
    const open = list.filter((a) => a.status === "open");
    const lockedCount = list.length - open.length;
    return (
      <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
        <Paperclip className="size-4 text-muted-foreground" />
        {open.map((a) =>
          canDownload ? (
            <a
              key={a.id}
              href={fileUrl(a.storageKey)}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
            >
              📎 {a.originalName}
              <span className="text-muted-foreground">（{a.downloads} 次下载）</span>
            </a>
          ) : (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
            >
              📎 {a.originalName}
              <span>（{viewer.userId === null ? "登录后下载" : "无下载权限"}）</span>
            </span>
          ),
        )}
        {lockedCount > 0 && (
          <span
            data-testid="locked-attachments"
            className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
          >
            🔒 本帖有 {lockedCount} 个附件需解锁后下载
          </span>
        )}
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

      {gateNotice && Object.hasOwn(GATE_NOTICES, gateNotice) && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {GATE_NOTICES[gateNotice]}
        </p>
      )}

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
          <PostBody
            md={thread.first.bodyMd}
            hasGate={thread.first.hasGate}
            gates={gates.get(thread.first.id)}
            pointsName={pointsName}
            returnPage={replies.page}
          />
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
                <PostBody
                  md={f.bodyMd}
                  hasGate={f.hasGate}
                  gates={gates.get(f.id)}
                  pointsName={pointsName}
                  returnPage={replies.page}
                />
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
