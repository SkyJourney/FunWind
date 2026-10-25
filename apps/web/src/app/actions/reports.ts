"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
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
