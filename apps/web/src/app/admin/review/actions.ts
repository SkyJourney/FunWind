"use server";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { approveReview, hidePost, rejectReview } from "@/lib/moderation/review";

/**
 * 审核 Server Actions（M9）：approve / reject / hide。鉴权在服务内（forum.moderate 按帖子版块作用域），
 * 入口再拦一道 site.admin/admin.recycle 之外的版主可达（defineAction 的 auth 只认 AdminPermission——
 * 版主没有 site.admin，因此这里用 auth:"user" + 服务内作用域判定；越权表现 404）。
 */

const postIdInput = z.object({ postId: z.coerce.number().int().positive() });

export const approveReviewAction = defineAction({
  name: "moderation.approve",
  auth: "user",
  input: postIdInput,
  async run(ctx, input) {
    const r = await approveReview(ctx.subject, input.postId, adminActor(ctx));
    if (!r.ok) redirect(backWith(input.postId, r.code, r.message));
    revalidatePath("/admin/review");
    revalidatePath(`/t/${threadIdOf(input.postId)}`);
    redirect("/admin/review?approved=1");
  },
});

const rejectInput = z.object({
  postId: z.coerce.number().int().positive(),
  reason: z.string().max(500).default(""),
});

export const rejectReviewAction = defineAction({
  name: "moderation.reject",
  auth: "user",
  input: rejectInput,
  async run(ctx, input) {
    const r = await rejectReview(ctx.subject, input.postId, input.reason, adminActor(ctx));
    if (!r.ok) redirect(backWith(input.postId, r.code, r.message));
    revalidatePath("/admin/review");
    redirect("/admin/review?rejected=1");
  },
});

const hideInput = z.object({
  postId: z.coerce.number().int().positive(),
  reason: z.string().max(500).default(""),
});

export const hidePostAction = defineAction({
  name: "moderation.hide",
  auth: "user",
  input: hideInput,
  async run(ctx, input) {
    const r = await hidePost(ctx.subject, input.postId, input.reason, adminActor(ctx));
    if (!r.ok) notFound();
    revalidatePath(`/t/${threadIdOf(input.postId)}`);
    redirect(`/t/${threadIdOf(input.postId)}`);
  },
});

// —— 以下为本文件私有辅助 ——

function adminActor(ctx: { userId: number | null; ip: string | null }): {
  userId: number;
  via: "admin";
  ip: string | null;
} {
  return { userId: ctx.userId ?? 0, via: "admin", ip: ctx.ip };
}

function backWith(postId: number, code: string, message: string): string {
  return `/admin/review?error=${encodeURIComponent(`${code}：${message}`)}&postId=${postId}`;
}

async function threadIdOf(postId: number): Promise<number> {
  const { getWebDb, posts } = await import("@funwind/db");
  const { eq } = await import("drizzle-orm");
  const [row] = await getWebDb()
    .select({ threadId: posts.threadId })
    .from(posts)
    .where(eq(posts.id, postId));
  return row?.threadId ?? 0;
}
