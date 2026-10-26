"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { attachmentsField } from "@/lib/uploads/attachments-field";
import { defineAction } from "@/lib/actions/define-action";
import { checkPermission } from "@/lib/authz/service";
import { createThread } from "@/lib/posting/service";

/**
 * 发主题 Server Action（M6.2 第 2 步）。
 * - 结构校验失败（缺版块号、非数字等）→ 404，与其它 Action 一致；
 * - 业务失败（标题空、超长、无权限、频控……）→ 跳回发帖页并带固定错误码（?error=…），
 *   URL 里不带标题与正文；草稿由客户端 localStorage 恢复（components/posting/thread-composer.tsx）；
 * - 成功 → 跳到新主题（待审时作者本人可见，页面会显示审核中的横幅）。
 */

/** 长度上限只防巨型输入（超过 200 万字符的请求直接按结构错误拒绝）；真正的标题 / 正文上限由 createThread 按角色限制判定 */
const createThreadInput = z.object({
  forumId: z.coerce.number().int().positive(),
  title: z.string().max(1000).default(""),
  source: z.string().max(200_000).default(""),
  attachments: attachmentsField,
  tags: z.string().max(500).default(""),
  /** 投票：「选项1\n选项2…」多行文本 + 单/多选 + 截止 + 结果可见性；空选项 = 不建投票 */
  pollOptions: z.string().max(6000).default(""),
  pollOptionLimit: z.coerce.number().int().min(1).max(20).default(1),
  pollEndsAt: z.string().max(32).default(""),
  pollResultAfterVote: z.enum(["on"]).optional(),
});

/** 投票表单字段 → service 输入；空选项返回 undefined（普通主题） */
function buildPollInput(
  raw: string,
  optionLimit: number,
  endsAt: string,
  afterVote: boolean,
):
  | {
      options: string[];
      optionLimit: number;
      endsAt: string | null;
      resultVisibility: "always" | "after_vote";
    }
  | undefined {
  const options = raw
    .split(/\r?\n/)
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (options.length < 2) return undefined;
  return {
    options,
    optionLimit,
    endsAt: endsAt ? `${endsAt.replace("T", " ")}:00`.slice(0, 19) : null,
    resultVisibility: afterVote ? "after_vote" : "always",
  };
}

export const createThreadAction = defineAction({
  name: "thread.create",
  auth: "user",
  input: createThreadInput,
  async run(ctx, input) {
    const canAddTags = (await checkPermission(ctx.subject, "tag.add")).allowed;
    const r = await createThread(ctx.subject, {
      forumId: input.forumId,
      title: input.title,
      source: input.source,
      attachments: input.attachments,
      tags: input.tags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      poll: buildPollInput(
        input.pollOptions,
        input.pollOptionLimit,
        input.pollEndsAt,
        input.pollResultAfterVote === "on",
      ),
      canAddTags,
    });
    if (r.ok) redirect(`/t/${r.threadId}`);
    redirect(`/f/${input.forumId}/new?error=${r.code}`);
  },
});
