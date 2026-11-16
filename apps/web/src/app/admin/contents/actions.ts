"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { approveReview, disableContent, hidePost, rejectReview } from "@/lib/moderation/review";
import { setThreadFlags } from "@/lib/moderation/contents";
import { deletePost } from "@/lib/posting/mutate";
import { getCurrentSubject } from "@/lib/authz/subject";
import { appendQueryParam } from "@/lib/admin/query";

/**
 * 内容治理动作（M9.5 §9.2；M19 吸收原 review 页批量审核与彻底删）：
 * 「内容管理」页的行内操作 + 批量通过/驳回 + 封禁终态的彻底删除 + 前台帖子页的就地治理。
 * 权限：版主（forum.moderate 作用域）在服务层按版块判定；admin 走同一服务路径。
 * 回跳：表单带 back（页面当前筛选 URL），成功/失败提示参数追加其上——筛选态不丢。
 */

const postIdInput = z.object({ postId: z.coerce.number().int().positive() });

/** 回跳路径白名单：必须站内相对路径（防开放跳转），页面用 baseQuery 生成 */
const backPath = z
  .string()
  .max(200)
  .regex(/^\/(?!\/)/, "回跳路径必须是站内相对路径")
  .default("/admin/contents");

/** 封禁内容（→ disabled，终态）：作者可见标题+理由横幅，但不可编辑不可重审 */
export const disableContentAction = defineAction({
  name: "moderation.disable",
  auth: "user",
  input: postIdInput.extend({ reason: z.string().min(1).max(500) }),
  async run(ctx, input) {
    const subject = await getCurrentSubject();
    const r = await disableContent(subject, input.postId, input.reason, ctx.actor);
    if (!r.ok) redirect(`/admin/contents?err=${encodeURIComponent(r.message)}`);
    revalidatePath("/admin/contents");
    redirect("/admin/contents?ok=disabled");
  },
});

/** 就地通过（pending → visible）：待审队列行内按钮；back 保留当前筛选 */
export const approveContentAction = defineAction({
  name: "moderation.approve_inline",
  auth: "user",
  input: postIdInput.extend({ back: backPath }),
  async run(ctx, input) {
    const subject = await getCurrentSubject();
    const r = await approveReview(subject, input.postId, ctx.actor);
    if (!r.ok) redirect(appendQueryParam(input.back, "err", r.message));
    revalidatePath("/admin/contents");
    redirect(appendQueryParam(input.back, "ok", "approved"));
  },
});

/** 就地驳回（pending → rejected）：共用一个理由输入 */
export const rejectContentAction = defineAction({
  name: "moderation.reject_inline",
  auth: "user",
  input: postIdInput.extend({ reason: z.string().min(1).max(500), back: backPath }),
  async run(ctx, input) {
    const subject = await getCurrentSubject();
    const r = await rejectReview(subject, input.postId, input.reason, ctx.actor);
    if (!r.ok) redirect(appendQueryParam(input.back, "err", r.message));
    revalidatePath("/admin/contents");
    redirect(appendQueryParam(input.back, "ok", "rejected"));
  },
});

/** 屏蔽（visible → hidden）：后台内容管理页入口（前台帖子页另有同语义公开入口） */
export const hideContentAction = defineAction({
  name: "moderation.hide_inline",
  auth: "user",
  input: postIdInput.extend({ reason: z.string().min(1).max(500) }),
  async run(ctx, input) {
    const subject = await getCurrentSubject();
    const r = await hidePost(subject, input.postId, input.reason, ctx.actor);
    if (!r.ok) redirect(`/admin/contents?err=${encodeURIComponent(r.message)}`);
    revalidatePath("/admin/contents");
    redirect("/admin/contents?ok=hidden");
  },
});

/**
 * 彻底删除（disabled → deleted，终态不可恢复）：封禁内容的唯一后续（M9.5 拍板语义，
 * M19 起入口在内容管理页）。版主删他人内容理由必填（服务层 rules.canDelete 判定）。
 */
export const purgeContentAction = defineAction({
  name: "moderation.purge",
  auth: "user",
  input: postIdInput.extend({ reason: z.string().min(1).max(500), back: backPath }),
  async run(ctx, input) {
    const subject = await getCurrentSubject();
    const r = await deletePost(subject, { postId: input.postId, reason: input.reason });
    if (!r.ok) redirect(appendQueryParam(input.back, "err", r.message));
    revalidatePath("/admin/contents");
    revalidatePath(`/t/${r.threadId}`);
    if (r.kind === "thread") revalidatePath(`/f/${r.forumId}`);
    redirect(appendQueryParam(input.back, "ok", "purged"));
  },
});

/**
 * 主题级设置（M9.5 §9.2-C）：锁定（is_locked）/ 置顶（pin_level）/ 精华（is_featured）。
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
    back: backPath,
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
      ctx.actor,
    );
    if (!r.ok) redirect(appendQueryParam(input.back, "err", r.message));
    revalidatePath("/admin/contents");
    revalidatePath(`/t/${input.threadId}`);
    redirect(appendQueryParam(input.back, "ok", "thread-flags"));
  },
});

// —— 批量审核（M9.5 引入；M19 自 review 页并入）：checkbox 多选 + 共用理由；
// 逐条独立事务（部分成功反馈失败数），每次最多 50 条 ——

const postIdsInput = z.object({
  postIds: z.preprocess(
    (v) => (Array.isArray(v) ? v : [v]),
    z.array(z.coerce.number().int().positive()).min(1).max(50),
  ),
  back: backPath,
});

export const approveReviewBulkAction = defineAction({
  name: "moderation.approve_bulk",
  auth: "user",
  input: postIdsInput,
  async run(ctx, input) {
    let ok = 0;
    const failed: string[] = [];
    for (const postId of input.postIds) {
      const r = await approveReview(ctx.subject, postId, ctx.actor);
      if (r.ok) ok += 1;
      else failed.push(`#${postId} ${r.code}`);
    }
    revalidatePath("/admin/contents");
    if (failed.length > 0) {
      redirect(
        appendQueryParam(
          input.back,
          "error",
          `批量通过：成功 ${ok} 条，失败 ${failed.length} 条（${failed.slice(0, 3).join("、")}）`,
        ),
      );
    }
    redirect(appendQueryParam(input.back, "ok", `approved=${ok}`));
  },
});

export const rejectReviewBulkAction = defineAction({
  name: "moderation.reject_bulk",
  auth: "user",
  input: postIdsInput.extend({ reason: z.string().min(1).max(500) }),
  async run(ctx, input) {
    let ok = 0;
    const failed: string[] = [];
    for (const postId of input.postIds) {
      const r = await rejectReview(ctx.subject, postId, input.reason, ctx.actor);
      if (r.ok) ok += 1;
      else failed.push(`#${postId} ${r.code}`);
    }
    revalidatePath("/admin/contents");
    if (failed.length > 0) {
      redirect(
        appendQueryParam(
          input.back,
          "error",
          `批量驳回：成功 ${ok} 条，失败 ${failed.length} 条（${failed.slice(0, 3).join("、")}）`,
        ),
      );
    }
    redirect(appendQueryParam(input.back, "ok", `rejected=${ok}`));
  },
});
