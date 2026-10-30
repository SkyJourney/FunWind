"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { defineAction } from "@/lib/actions/define-action";
import { hashEmailKey } from "@/lib/auth/tokens";
import { AppealError, submitAppealAsUser, submitAppealWithPassword } from "@/lib/authz/appeals";

function message(error: unknown): string {
  if (!(error instanceof AppealError)) return "暂时无法提交申诉，请稍后重试。";
  switch (error.code) {
    case "no_active_restrictions":
      return "当前没有可申诉的有效账号限制。";
    case "already_pending":
      return "已有待处理申诉，请等待处理结果。";
    case "result_required":
      return "请填写申诉理由。";
    default:
      return "无法验证账号或申诉目标，请检查信息后重试。";
  }
}

export const submitAppealAction = defineAction({
  name: "account.appeal.submit",
  auth: "guest",
  input: z.object({
    identifier: z.string().trim().max(254).default(""),
    current: z.string().max(1024).default(""),
    reason: z.string().trim().min(1).max(2000),
  }),
  rateLimit: [
    {
      key: (ctx, input) =>
        ctx.userId === null
          ? `appeal:identity:${hashEmailKey(input.identifier.trim().toLowerCase())}`
          : `appeal:user:${ctx.userId}`,
      max: 5,
      windowMs: 60 * 60_000,
      onLimit: () => redirect("/appeal?error=操作过于频繁，请稍后再试"),
    },
    {
      key: (ctx) => (ctx.ip ? `appeal:ip:${ctx.ip}` : null),
      max: 10,
      windowMs: 60 * 60_000,
      onLimit: () => redirect("/appeal?error=操作过于频繁，请稍后再试"),
    },
  ],
  async run(ctx, input) {
    try {
      if (ctx.userId !== null) {
        await submitAppealAsUser(ctx.userId, input.reason, ctx.ip);
      } else {
        await submitAppealWithPassword(input.identifier, input.current, input.reason, ctx.ip);
      }
    } catch (error) {
      if (error instanceof AppealError) {
        redirect(`/appeal?error=${encodeURIComponent(message(error))}`);
      }
      throw error;
    }
    redirect("/appeal?submitted=1");
  },
});
