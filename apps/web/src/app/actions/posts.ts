"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getWebDb, posts } from "@funwind/db";
import { attachmentsField } from "@/lib/uploads/attachments-field";
import { defineAction, type ActionContext } from "@/lib/actions/define-action";
import { getCurrentSubject } from "@/lib/authz/subject";
import {
  approveReview,
  disableContent,
  hidePost,
  rejectReview,
  type ReviewOutcome,
} from "@/lib/moderation/review";
import { deletePost, editPost, restorePost } from "@/lib/posting/mutate";
import { locatePost, postPath } from "@/lib/queries/locate-post";

/**
 * 编辑帖子 Server Action（M6.2 第 4 步）。
 * - 结构校验失败 → 404；业务失败（冲突、理由必填、时限、门控改动受限、标题空……）→ 跳回编辑页带固定错误码
 *   （?error=…），URL 里不带正文与理由；草稿由客户端 localStorage 恢复（components/posting/edit-composer.tsx）；
 * - 成功 → 跳到该帖所在的页与锚点；对作者不可见（如重新提交审核后）时回到主题首页。
 * expectedEditedAt 是渲染表单时看到的 edited_at：空串表示「从未编辑」。
 */
const editPostInput = z.object({
  postId: z.coerce.number().int().positive(),
  title: z.string().max(1000).default(""),
  source: z.string().max(200_000).default(""),
  expectedEditedAt: z.string().max(40).default(""),
  reason: z.string().max(1000).default(""),
  attachments: attachmentsField,
  tags: z.string().max(500).default(""),
});

export const editPostAction = defineAction({
  name: "post.edit",
  auth: "user",
  input: editPostInput,
  async run(ctx, input) {
    const r = await editPost(ctx.subject, {
      postId: input.postId,
      source: input.source,
      title: input.title,
      expectedEditedAt: input.expectedEditedAt === "" ? null : input.expectedEditedAt,
      reason: input.reason,
      attachments: input.attachments,
      tags: input.tags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    });
    if (!r.ok) redirect(`/p/${input.postId}/edit?error=${r.code}`);
    // 与回复相同的理由：同路径的哈希跳转会复用旧缓存，先让该主题失效
    revalidatePath(`/t/${r.threadId}`);
    const loc = await locatePost(ctx.subject, r.postId);
    redirect(loc ? postPath(loc) : `/t/${r.threadId}`);
  },
});

/**
 * 删除帖子 Server Action（M6.2 第 5 步）。作者删自己的（无理由）；版主删别人的必须填理由（写审计）。
 * 删除主题后主题页已不可见，所以跳回版块列表；删除回帖则回到主题页。
 */
const deletePostInput = z.object({
  postId: z.coerce.number().int().positive(),
  reason: z.string().max(1000).default(""),
});

export const deletePostAction = defineAction({
  name: "post.delete",
  auth: "user",
  input: deletePostInput,
  async run(ctx, input) {
    const r = await deletePost(ctx.subject, { postId: input.postId, reason: input.reason });
    if (!r.ok) redirect(`/p/${input.postId}/delete?error=${r.code}`);
    revalidatePath(`/t/${r.threadId}`);
    redirect(r.kind === "thread" ? `/f/${r.forumId}` : `/t/${r.threadId}`);
  },
});

/** 恢复帖子 Server Action（M6.2 第 5 步）：只有版主，理由必填（写审计）。 */
const restorePostInput = z.object({
  postId: z.coerce.number().int().positive(),
  reason: z.string().max(1000).default(""),
});

export const restorePostAction = defineAction({
  name: "post.restore",
  auth: "user",
  input: restorePostInput,
  async run(ctx, input) {
    const r = await restorePost(ctx.subject, { postId: input.postId, reason: input.reason });
    if (!r.ok) redirect(`/p/${input.postId}/restore?error=${r.code}`);
    revalidatePath(`/t/${r.threadId}`);
    const loc = await locatePost(ctx.subject, r.postId);
    redirect(loc ? postPath(loc) : `/t/${r.threadId}`);
  },
});

const moderationPostInput = z.object({ postId: z.coerce.number().int().positive() });
const moderationReasonInput = moderationPostInput.extend({ reason: z.string().min(1).max(500) });

/** 前台治理仍沿用既有审计来源；权限由 moderation 服务按帖子所在版块判定。 */
function moderationActor(ctx: ActionContext) {
  return { userId: ctx.userId ?? 0, via: "admin" as const, ip: ctx.ip };
}

/** 屏蔽的前台公开入口：保留空理由业务校验、失败 404 与主题回跳。 */
export const hidePostAction = defineAction({
  name: "moderation.hide",
  auth: "user",
  input: moderationPostInput.extend({ reason: z.string().max(500).default("") }),
  async run(ctx, input) {
    const result = await hidePost(ctx.subject, input.postId, input.reason, moderationActor(ctx));
    if (!result.ok) notFound();
    const [post] = await getWebDb()
      .select({ threadId: posts.threadId })
      .from(posts)
      .where(eq(posts.id, input.postId));
    const target = `/t/${post?.threadId ?? 0}`;
    revalidatePath(target);
    redirect(target);
  },
});

type ContentReviewKind = "approve" | "reject" | "disable";

/** 就地治理共用薄编排，保留既有后台回跳与刷新顺序，不引入后台 Action 依赖。 */
async function runContentReview(
  ctx: ActionContext,
  input: { postId: number; reason?: string },
  kind: ContentReviewKind,
): Promise<void> {
  const subject = await getCurrentSubject();
  const actor = moderationActor(ctx);
  const result: ReviewOutcome =
    kind === "approve"
      ? await approveReview(subject, input.postId, actor)
      : kind === "reject"
        ? await rejectReview(subject, input.postId, input.reason!, actor)
        : await disableContent(subject, input.postId, input.reason!, actor);
  const errorPath = kind === "approve" ? "/admin/review" : "/admin/contents";
  if (!result.ok) redirect(`${errorPath}?error=${encodeURIComponent(result.message)}`);
  const paths =
    kind === "disable"
      ? ["/admin/contents", "/admin/review"]
      : ["/admin/review", "/admin/contents"];
  for (const path of paths) revalidatePath(path);
  const target =
    kind === "disable"
      ? "/admin/contents?disabled=1"
      : `/admin/review?${kind === "approve" ? "approved" : "rejected"}=1`;
  redirect(target);
}

/** 前台就地通过：登录门后仍由服务校验 forum.moderate 作用域。 */
export const approveContentAction = defineAction({
  name: "moderation.approve_inline",
  auth: "user",
  input: moderationPostInput,
  run: (ctx, input) => runContentReview(ctx, input, "approve"),
});

/** 前台就地驳回：理由输入与既有入口一致。 */
export const rejectContentAction = defineAction({
  name: "moderation.reject_inline",
  auth: "user",
  input: moderationReasonInput,
  run: (ctx, input) => runContentReview(ctx, input, "reject"),
});

/** 前台封禁：复用服务状态机，保留终态与既有反馈。 */
export const disableContentAction = defineAction({
  name: "moderation.disable",
  auth: "user",
  input: moderationReasonInput,
  run: (ctx, input) => runContentReview(ctx, input, "disable"),
});
