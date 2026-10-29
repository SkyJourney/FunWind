"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { approveReview, disableContent, hidePost, rejectReview } from "@/lib/moderation/review";
import { setThreadFlags } from "@/lib/moderation/contents";
import { getCurrentSubject } from "@/lib/authz/subject";

/**
 * 内容治理动作（M9.5 §9.2）：后台「内容管理」页的行内操作 + 前台帖子页的就地治理。
 * 权限：版主（forum.moderate 作用域）在服务层按版块判定；admin 走同一服务路径。
 */

const postIdInput = z.object({ postId: z.coerce.number().int().positive() });

/** 封禁内容（→ disabled，终态）：作者可见标题+理由横幅，但不可编辑不可重审 */
export const disableContentAction = defineAction({
  name: "moderation.disable",
  auth: "user",
  input: postIdInput.extend({ reason: z.string().min(1).max(500) }),
  async run(ctx, input) {
    const subject = await getCurrentSubject();
    const r = await disableContent(subject, input.postId, input.reason, {
      userId: ctx.userId ?? 0,
      via: "admin",
      ip: ctx.ip,
    });
    if (!r.ok) redirect(`/admin/contents?error=${encodeURIComponent(r.message)}`);
    revalidatePath("/admin/contents");
    revalidatePath("/admin/review");
    redirect("/admin/contents?disabled=1");
  },
});

/** 前台就地通过（pending → visible）：版主在帖子页直接过审，不必跳后台 */
export const approveContentAction = defineAction({
  name: "moderation.approve_inline",
  auth: "user",
  input: postIdInput,
  async run(ctx, input) {
    const subject = await getCurrentSubject();
    const r = await approveReview(subject, input.postId, {
      userId: ctx.userId ?? 0,
      via: "admin",
      ip: ctx.ip,
    });
    if (!r.ok) redirect(`/t/0?error=${encodeURIComponent(r.message)}`);
    revalidatePath("/admin/review");
    revalidatePath("/admin/contents");
    redirect("/admin/review?approved=1");
  },
});

/** 前台就地驳回（pending → rejected）：共用一个理由输入 */
export const rejectContentAction = defineAction({
  name: "moderation.reject_inline",
  auth: "user",
  input: postIdInput.extend({ reason: z.string().min(1).max(500) }),
  async run(ctx, input) {
    const subject = await getCurrentSubject();
    const r = await rejectReview(subject, input.postId, input.reason, {
      userId: ctx.userId ?? 0,
      via: "admin",
      ip: ctx.ip,
    });
    if (!r.ok) redirect(`/admin/contents?error=${encodeURIComponent(r.message)}`);
    revalidatePath("/admin/review");
    revalidatePath("/admin/contents");
    redirect("/admin/review?rejected=1");
  },
});

/** 屏蔽（visible → hidden）：后台内容管理页补上入口（原先只有前台帖子页有） */
export const hideContentAction = defineAction({
  name: "moderation.hide_inline",
  auth: "user",
  input: postIdInput.extend({ reason: z.string().min(1).max(500) }),
  async run(ctx, input) {
    const subject = await getCurrentSubject();
    const r = await hidePost(subject, input.postId, input.reason, {
      userId: ctx.userId ?? 0,
      via: "admin",
      ip: ctx.ip,
    });
    if (!r.ok) redirect(`/admin/contents?error=${encodeURIComponent(r.message)}`);
    revalidatePath("/admin/contents");
    revalidatePath("/admin/review");
    redirect("/admin/contents?hidden=1");
  },
});

/**
 * 主题级设置（M9.5 §9.2-C）：锁定（is_locked）/ 置顶（pin_level）/ 精华（is_featured）——
 * 此前三者只有读侧（徽标展示、回复拦截），全仓库无写入口。
 * 置顶级别：0 无 / 1 版块 / 2 分区 / 3 全站（版主最高可设 1，site.admin 可设 3）。
 */
export const threadFlagsAction = defineAction({
  name: "admin.thread.flags",
  auth: "user",
  input: z.object({
    threadId: z.coerce.number().int().positive(),
    locked: z.enum(["0", "1"]).optional(),
    featured: z.enum(["0", "1"]).optional(),
    pinLevel: z.coerce.number().int().min(0).max(3).optional(),
    back: z.string().max(200).default("/admin/contents"),
  }),
  async run(ctx, input) {
    const subject = await getCurrentSubject();
    const r = await setThreadFlags(
      subject,
      input.threadId,
      {
        ...(input.locked !== undefined ? { locked: input.locked === "1" } : {}),
        ...(input.featured !== undefined ? { featured: input.featured === "1" } : {}),
        ...(input.pinLevel !== undefined ? { pinLevel: input.pinLevel } : {}),
      },
      { userId: ctx.userId ?? 0, via: "admin", ip: ctx.ip },
    );
    if (!r.ok) redirect(`/admin/contents?error=${encodeURIComponent(r.message)}`);
    revalidatePath("/admin/contents");
    revalidatePath(`/t/${input.threadId}`);
    redirect(`${input.back}?saved=thread-flags`);
  },
});
