"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { attachmentsField } from "@/lib/uploads/attachments-field";
import { defineAction } from "@/lib/actions/define-action";
import { createThread } from "@/lib/posting/service";

/**
 * 发主题 Server Action（M6.2 第 2 步）。
 * - 结构校验失败（缺版块号、非数字等）→ 404，与其它 Action 一致；
 * - 业务失败（标题空、超长、无权限、频控……）→ 跳回发帖页并带固定错误码（?error=…），
 *   URL 里不带标题与正文；草稿由客户端 sessionStorage 恢复（components/posting/thread-composer.tsx）；
 * - 成功 → 跳到新主题（待审时作者本人可见，页面会显示审核中的横幅）。
 */

/** 长度上限只防巨型输入（超过 200 万字符的请求直接按结构错误拒绝）；真正的标题 / 正文上限由 createThread 按角色限制判定 */
const createThreadInput = z.object({
  forumId: z.coerce.number().int().positive(),
  title: z.string().max(1000).default(""),
  source: z.string().max(200_000).default(""),
  attachments: attachmentsField,
});

export const createThreadAction = defineAction({
  name: "thread.create",
  auth: "user",
  input: createThreadInput,
  async run(ctx, input) {
    const r = await createThread(ctx.subject, {
      forumId: input.forumId,
      title: input.title,
      source: input.source,
      attachments: input.attachments,
    });
    if (r.ok) redirect(`/t/${r.threadId}`);
    redirect(`/f/${input.forumId}/new?error=${r.code}`);
  },
});
