"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { reportSubmitRateLimit } from "@/lib/auth/rate-limit-policies";
import { submitReport } from "@/lib/reports/service";

/** 前台举报提交（M9）：member 基线 forum.report；同人同帖幂等（already 提示已举报）。 */

const reportInput = z.object({
  postId: z.coerce.number().int().positive(),
  reason: z.string().max(1000).default(""),
});

export const reportPostAction = defineAction({
  name: "report.submit",
  auth: "user",
  input: reportInput,
  // 同人同帖有唯一键幂等，但跨帖子刷举报无约束——按用户限流保护后台队列
  rateLimit: [
    {
      key: (ctx) => reportSubmitRateLimit.key(ctx.userId!),
      max: reportSubmitRateLimit.max,
      windowMs: reportSubmitRateLimit.windowMs,
      onLimit: (_ctx, input) =>
        redirect(
          `/p/${input.postId}/report?error=${encodeURIComponent("举报过于频繁，请稍后再试")}#form`,
        ),
    },
  ],
  async run(ctx, input) {
    const r = await submitReport(ctx.subject, input.postId, input.reason);
    if (!r.ok) {
      const messages: Record<string, string> = {
        not_found: "帖子不存在或不可见",
        forbidden: "你没有举报权限",
        already: "你已举报过这条内容，处理结果会通知你",
        reason_required: "请填写举报理由",
      };
      const msg = messages[r.code] ?? "提交失败，请稍后重试";
      redirect(`/p/${input.postId}/report?error=${encodeURIComponent(msg)}#form`);
    }
    revalidatePath("/admin/reports");
    redirect(`/p/${input.postId}/report?done=1`);
  },
});
