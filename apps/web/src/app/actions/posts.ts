"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { deletePost, editPost, restorePost } from "@/lib/posting/mutate";
import { locatePost, postPath } from "@/lib/queries/locate-post";

/**
 * 编辑帖子 Server Action（M6.2 第 4 步）。
 * - 结构校验失败 → 404；业务失败（冲突、理由必填、时限、门控改动受限、标题空……）→ 跳回编辑页带固定错误码
 *   （?error=…），URL 里不带正文与理由；草稿由客户端 sessionStorage 恢复（components/posting/edit-composer.tsx）；
 * - 成功 → 跳到该帖所在的页与锚点；对作者不可见（如重新提交审核后）时回到主题首页。
 * expectedEditedAt 是渲染表单时看到的 edited_at：空串表示「从未编辑」。
 */
const editPostInput = z.object({
  postId: z.coerce.number().int().positive(),
  title: z.string().max(1000).default(""),
  source: z.string().max(200_000).default(""),
  expectedEditedAt: z.string().max(40).default(""),
  reason: z.string().max(1000).default(""),
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
