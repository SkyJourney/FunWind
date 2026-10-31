import { ViewBeacon } from "@/components/content/view-beacon";
import { ImageLightbox } from "@/components/content/image-lightbox";
import { ArrowLeft, Clock, Eye, MessageSquare, Paperclip, XCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pagination } from "@/components/content/pagination";
import { PostBody } from "@/components/content/post-body";
import { UserBadge } from "@/components/content/user-badge";
import { LikeButton } from "@/components/interact/like-button";
import PollBlock from "@/components/interact/poll-block";
import { getEnabledModuleIds } from "@/modules/kernel/state";
import { likedPostIds } from "@/lib/interact/reactions";
import { tagsOfThreads } from "@/lib/interact/tags";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ReplyComposer } from "@/components/posting/reply-composer";
import { ReplyFab } from "@/components/posting/reply-fab";
import { PostActionLink } from "@/components/posting/post-action-link";
import { ReviewTimeline } from "@/components/content/review-timeline";
import {
  approveContentAction,
  disableContentAction,
  rejectContentAction,
} from "@/app/admin/contents/actions";
import { listContentReviews } from "@/lib/moderation/review";
import { deletePostAction, restorePostAction } from "@/app/actions/posts";
import { reportPostAction } from "@/app/actions/reports";
import { hidePostAction } from "@/app/admin/review/actions";
import { draftKey } from "@/components/editor/draft";
import { createReplyAction } from "@/app/actions/replies";
import { getPointsName } from "@/lib/auth/settings";
import { checkPermission } from "@/lib/authz/service";
import { getCurrentSubject } from "@/lib/authz/subject";
import { limitsFor } from "@/lib/limits/load";
import { listAttachments } from "@/lib/gates/attachments";
import { loadGateViews } from "@/lib/gates/service";
import { fileUrl } from "@/lib/files";
import { loadReplyAccess } from "@/lib/posting/compose-access";
import { postingNoticeText, REPLY_REVIEW_HINT } from "@/lib/posting/compose";
import { getForumView } from "@/lib/queries/forums";
import { listReplies } from "@/lib/queries/posts";
import { locateParents } from "@/lib/queries/locate-post";
import { getCurrentThreadView } from "@/lib/queries/threads";
import {
  attachmentDenyReason,
  gateNoticeText,
  lockedAttachmentNotice,
  parentLink,
  replyBadge,
  repliesHeading,
  splitAttachments,
  threadBanner,
} from "@/lib/queries/thread-page";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ tid: string }>;
  searchParams: Promise<{ page?: string; gate?: string; reply?: string; vote?: string }>;
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
  const { page: pageRaw, gate: gateNotice, reply: replyCode, vote: voteError } = await searchParams;

  const viewer = await getCurrentSubject();
  // 不存在 / 版块读不到 / 屏蔽或删除（非版主）/ 别人的待审核 → 一律 404，不暴露存在性
  const thread = await getCurrentThreadView(tid);
  if (!thread) notFound();

  const banner = threadBanner(thread.state, thread.review?.note);
  const notice = gateNoticeText(gateNotice);

  const [forum, replies, replyEntry, limits] = await Promise.all([
    getForumView(viewer, thread.forumId),
    listReplies(viewer, thread, Math.max(1, Number(pageRaw ?? "1") || 1)),
    loadReplyAccess(viewer, thread.forumId, thread.isLocked),
    limitsFor(viewer, thread.forumId),
  ]);
  const replyNotice = postingNoticeText(replyCode);
  // 一页的全部门控一次解析：作者/版主/已解锁者拿到正文，其余人拿到锁卡片（锁卡片里没有正文）
  const gatePosts = [
    { id: thread.first.id, authorId: thread.authorId, hasGate: thread.first.hasGate },
    ...replies.items.map((r) => ({ id: r.id, authorId: r.authorId, hasGate: r.hasGate })),
  ];
  // 附件下载权限按版块判定，整页同属一个版块，只查一次；无权者看到附件名与原因，不渲染可点击链接（点进去只会是 404）
  const canDownload = (
    await checkPermission(viewer, "attachment.download", { forumId: thread.forumId })
  ).allowed;
  // 编辑入口：作者本人，或版主（版主可编辑任何未删除的可见内容）。版主身份整页只判定一次，逐帖只比较字段；
  // 真正的权限在编辑页与保存时再判定，这里只决定显示哪个入口
  const canModerate =
    viewer.userId !== null &&
    (await checkPermission(viewer, "forum.moderate", { forumId: thread.forumId })).allowed;
  const canEditPost = (authorId: number | null, state: string): boolean =>
    viewer.userId !== null && state !== "deleted" && (authorId === viewer.userId || canModerate);
  // 恢复入口只给版主，且只对已删除 / 已隐藏的内容显示（删除与恢复的判定在确认页与保存时再做）
  const canRestorePost = (state: string): boolean =>
    canModerate && (state === "deleted" || state === "hidden");
  const hasPostActions = (authorId: number | null, state: string): boolean =>
    canEditPost(authorId, state) || canRestorePost(state) || (canReport && state === "visible");
  const canHidePost = (authorId: number | null, state: string): boolean =>
    canModerate && state === "visible";
  // 举报入口：登录 + forum.report（member 基线）；按帖子状态在 postActions 内判定
  const canReport =
    viewer.userId !== null && (await checkPermission(viewer, "forum.report")).allowed;
  const postActions = (postId: number, authorId: number | null, state: string) => (
    <>
      {canEditPost(authorId, state) && (
        <>
          <Link href={`/p/${postId}/edit`} className="text-primary hover:underline">
            编辑
          </Link>
          <PostActionLink
            postId={postId}
            kind="delete"
            action={deletePostAction}
            reasonRequired={authorId !== viewer.userId}
          />
        </>
      )}
      {canHidePost(authorId, state) && (
        <PostActionLink postId={postId} kind="hide" action={hidePostAction} />
      )}
      {/* M9.5 §9.2-D：pending 帖就地过审（版主不必跳后台队列）；封禁（→disabled，终态） */}
      {canModerate && state === "pending" && (
        <>
          <form action={approveContentAction}>
            <input type="hidden" name="postId" value={postId} />
            <SubmitButton pendingText="通过中…" className="text-primary hover:underline">
              通过
            </SubmitButton>
          </form>
          <form action={rejectContentAction} className="inline-flex items-center gap-1">
            <input type="hidden" name="postId" value={postId} />
            <input
              name="reason"
              required
              maxLength={255}
              placeholder="驳回理由（必填）"
              aria-label="驳回理由"
              className="w-32 rounded border bg-background px-1.5 py-0.5 text-xs"
            />
            <SubmitButton pendingText="驳回中…" className="text-destructive hover:underline">
              驳回
            </SubmitButton>
          </form>
        </>
      )}
      {canModerate && (state === "visible" || state === "pending" || state === "rejected") && (
        <form action={disableContentAction} className="inline-flex items-center gap-1">
          <input type="hidden" name="postId" value={postId} />
          <input
            name="reason"
            required
            maxLength={255}
            placeholder="封禁理由（作者可见）"
            aria-label="封禁理由（作者可见）"
            className="w-32 rounded border bg-background px-1.5 py-0.5 text-xs"
          />
          <SubmitButton pendingText="封禁中…" className="text-destructive hover:underline">
            封禁
          </SubmitButton>
        </form>
      )}
      {canRestorePost(state) && (
        <PostActionLink postId={postId} kind="restore" action={restorePostAction} />
      )}
      {/* 举报不排除自己的帖子会显得荒谬（M9.5 §9.2-F）：作者本人不显示举报入口 */}
      {canReport && state === "visible" && authorId !== viewer.userId && (
        <PostActionLink postId={postId} kind="report" action={reportPostAction} />
      )}
    </>
  );
  const [attachments, parents, gates, pointsName] = await Promise.all([
    // 门控附件与隐藏正文同权：锁定项只带「存在一个」，不含文件名 / 存储键 / 大小（lib/gates/attachments.ts）
    listAttachments(viewer, thread, gatePosts),
    // 父帖按观众视角定位：不可见的父帖映射为 null，不渲染链接（也不泄露它的楼层）
    locateParents(
      viewer,
      replies.items.flatMap((r) => (r.replyToPostId ? [r.replyToPostId] : [])),
    ),
    loadGateViews(viewer, thread, gatePosts),
    getPointsName(),
  ]);
  const [likedSet, threadTags, enabledModules] = await Promise.all([
    viewer.userId !== null
      ? likedPostIds(viewer.userId, [thread.first.id, ...replies.items.map((r) => r.id)])
      : Promise.resolve(new Set<number>()),
    tagsOfThreads([thread.id]),
    getEnabledModuleIds(),
  ]);
  // 审核历史（M9.5 §9.2-G1）：仅作者本人与该版块版主可见（其他人不渲染，避免泄露审核过程）
  const canSeeReviewHistory =
    viewer.userId !== null && (viewer.userId === thread.authorId || canModerate);
  const reviewHistory = canSeeReviewHistory ? await listContentReviews(thread.first.id) : [];
  // 投票块随 poll 模块启停（模块装卸语义：能力随模块消失，主题与正文不受损）
  const pollEnabled = enabledModules.has("poll");
  const likeProps = (postId: number) => ({
    postId,
    liked: likedSet.has(postId),
    likeCount:
      postId === thread.first.id
        ? thread.first.likeCount
        : (replies.items.find((r) => r.id === postId)?.likeCount ?? 0),
    back: `/t/${thread.id}${replies.page > 1 ? `?page=${replies.page}` : ""}`,
    canLike: viewer.userId !== null,
  });

  const attachmentList = (postId: number) => {
    const list = attachments.get(postId) ?? [];
    if (list.length === 0) return null;
    const { open, lockedCount } = splitAttachments(list);
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
              <span>（{attachmentDenyReason(viewer.userId === null)}）</span>
            </span>
          ),
        )}
        {lockedCount > 0 && (
          <span
            data-testid="locked-attachments"
            className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
          >
            {lockedAttachmentNotice(lockedCount)}
          </span>
        )}
      </div>
    );
  };

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6">
      <ViewBeacon tid={thread.id} />
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

      {notice && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {notice}
        </p>
      )}

      {banner?.tone === "info" && (
        <p className="flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm text-info">
          <Clock className="size-4" /> {banner.text}
        </p>
      )}
      {banner?.tone === "destructive" && (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            {banner.text}
            {banner.reviewNote && <>驳回理由：{banner.reviewNote}</>}
          </span>
        </p>
      )}
      {banner?.tone === "muted" && (
        <p className="rounded-lg border bg-muted px-3 py-2 text-sm text-muted-foreground">
          {banner.text}
        </p>
      )}

      <header className="space-y-2">
        <h1 className="text-2xl leading-snug font-bold tracking-tight">
          {thread.prefixName && <span className="mr-2 text-primary">[{thread.prefixName}]</span>}
          {thread.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <UserBadge
            uid={thread.authorId ?? undefined}
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

      {/* 审核历史时间线（M9.5 §9.2-G1）：作者与版主可见 */}
      {reviewHistory.length > 0 && <ReviewTimeline entries={reviewHistory} />}

      {thread.kind === "poll" && pollEnabled && (
        <PollBlock threadId={thread.id} voteError={voteError} />
      )}

      {(threadTags.get(thread.id)?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {(threadTags.get(thread.id) ?? []).map((t) => (
            <Link
              key={t.id}
              href={`/f/${thread.forumId}?tag=${encodeURIComponent(t.name)}`}
              className="rounded-full border bg-card px-2.5 py-0.5 text-muted-foreground hover:text-primary"
            >
              #{t.name}
            </Link>
          ))}
        </div>
      )}

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
          <div className="mt-3 flex items-center gap-3 text-xs">
            <LikeButton {...likeProps(thread.first.id)} />
            {(thread.first.editedAt || hasPostActions(thread.authorId, thread.state)) && (
              <span className="flex items-center gap-3 text-muted-foreground">
                {thread.first.editedAt && <span>最后编辑于 {thread.first.editedAt}</span>}
                {postActions(thread.first.id, thread.authorId, thread.state)}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 回帖楼层 */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {repliesHeading(replies.total, replies.page, replies.totalPages)}
        </h2>
        {replies.items.length === 0 && (
          <div className="rounded-xl border border-dashed bg-card/50 px-6 py-10 text-center">
            <p className="font-medium">还没有回帖</p>
            <p className="mt-1 text-sm text-muted-foreground">来抢沙发，点亮这个主题</p>
          </div>
        )}
        {replies.items.map((f) => {
          // 父帖不可见时不渲染链接；可见时：本页内（或首帖）用页内锚点，否则带页码
          const link = parentLink(
            f.replyToPostId ? parents.get(f.replyToPostId) : undefined,
            replies.page,
          );
          return (
            <Card key={f.id} id={`p${f.id}`} className="scroll-mt-20">
              <CardHeader className="flex flex-row items-center justify-between gap-2 py-3">
                <UserBadge
                  uid={f.authorId ?? undefined}
                  name={f.authorName}
                  deleted={f.authorDeleted}
                />
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {replyBadge(f.state) && <Badge variant="outline">{replyBadge(f.state)}</Badge>}#
                  {f.floor}
                </span>
              </CardHeader>
              <CardContent className="space-y-2 pb-4">
                {link && (
                  <p className="text-xs text-muted-foreground">
                    ↩ 回复{" "}
                    <a href={link.href} className="text-primary hover:underline">
                      #{link.floor}
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
                <div className="flex items-center gap-3 text-xs">
                  <LikeButton {...likeProps(f.id)} />
                  <span className="flex items-center gap-3 text-muted-foreground">
                    <span>
                      {f.createdAt}
                      {f.editedAt && ` · 编辑于 ${f.editedAt}`}
                    </span>
                    {postActions(f.id, f.authorId, f.state)}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <Pagination basePath={`/t/${tid}`} page={replies.page} totalPages={replies.totalPages} />

      {/* 快速回复：只在主题可见时提供表单；锁定 / 归档 / 无权限时给出说明 */}
      <section id="reply" className="scroll-mt-20 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">快速回复</h2>
        {replyNotice && (
          <p
            role="alert"
            className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
          >
            {replyNotice}
          </p>
        )}
        {thread.state !== "visible" ? (
          <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
            该主题暂不接受回复。
          </p>
        ) : replyEntry.mode === "closed" ? (
          <Card>
            <CardContent className="space-y-3 pt-6 text-sm">
              <p>{replyEntry.text}</p>
              {replyEntry.loginHref && (
                <Link href={replyEntry.loginHref} className="text-primary hover:underline">
                  去登录
                </Link>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            {/* 移动端回复悬浮按钮：只在可以回复时出现，与本区互斥（进入本区即隐藏）；放在 Card 外，避免祖先样式影响 fixed */}
            <ReplyFab />
            <Card>
              <CardContent className="space-y-3 pt-6">
                {replyEntry.reviewHint && (
                  <p className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm text-info">
                    {REPLY_REVIEW_HINT}
                  </p>
                )}
                <ReplyComposer
                  action={createReplyAction}
                  threadId={tid}
                  forumId={thread.forumId}
                  page={replies.page}
                  draftKey={draftKey(viewer.userId, "reply", tid)}
                  restore={replyCode !== undefined}
                  bodyMax={limits.bodyMax}
                />
              </CardContent>
            </Card>
          </>
        )}
      </section>
      <ImageLightbox />
    </main>
  );
}
