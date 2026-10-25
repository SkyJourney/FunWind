"use server";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { toggleLike } from "@/lib/interact/reactions";
import { toggleFollow } from "@/lib/interact/follows";

/**
 * 互动 Server Actions（M8）：点赞 toggle / 关注 toggle。
 * 频控：单用户每分钟 30 次（超限回首页提示）；重复提交由 reactions/follows 主键 + toggle 语义兜底。
 * 表单携带 back 字段（站内路径）用于 revalidate——open redirect 由 startsWith("/") 排除。
 */

/** 站内回跳路径：缺失或非站内时回首页；剥除 query（revalidatePath 的隐式 tag 按不含 search 的路径生成） */
const backPath = (formData: FormData): string => {
  const raw = formData.get("back");
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw.split("?")[0]!;
};

const likeInput = z.object({ postId: z.coerce.number().int().positive() });
export const likeAction = defineAction({
  name: "interact.like",
  auth: "user",
  input: likeInput,
  rateLimit: [
    {
      key: (ctx) => `interact:${ctx.userId}`,
      max: 30,
      windowMs: 60_000,
      onLimit: () => redirect("/?interact=rate"),
    },
  ],
  async run(ctx, input, formData) {
    const r = await toggleLike(ctx.userId!, input.postId);
    if (!r.ok) notFound();
    revalidatePath(backPath(formData));
  },
});

const followInput = z.object({
  targetType: z.enum(["user", "forum"]),
  targetId: z.coerce.number().int().positive(),
});
export const followAction = defineAction({
  name: "interact.follow",
  auth: "user",
  input: followInput,
  rateLimit: [
    {
      key: (ctx) => `interact:${ctx.userId}`,
      max: 30,
      windowMs: 60_000,
      onLimit: () => redirect("/?interact=rate"),
    },
  ],
  async run(ctx, input, formData) {
    const r = await toggleFollow(ctx.userId!, input.targetType, input.targetId);
    if (!r.ok) notFound();
    revalidatePath(backPath(formData));
  },
});
