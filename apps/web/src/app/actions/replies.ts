"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { createReply } from "@/lib/posting/service";
import { locatePost, postPath } from "@/lib/queries/locate-post";

/**
 * 快速回复 Server Action（M6.2 第 3 步）。
 * - 结构校验失败（缺主题号、非数字等）→ 404，与其它 Action 一致；
 * - 业务失败（锁定、归档、门控语法错误、频控……）→ 跳回主题页表单所在的页，带固定错误码（?reply=…#reply），
 *   URL 里不带正文；草稿由客户端 sessionStorage 恢复（components/posting/reply-composer.tsx）；
 * - 成功 → 跳到新回复所在的页与锚点；对作者也不可见（待审）时回到主题首页。
 */
const createReplyInput = z.object({
  threadId: z.coerce.number().int().positive(),
  /** 表单提交时所在的回帖页：失败后跳回同一页，不把用户带回第一页 */
  page: z.coerce.number().int().min(1).max(100_000).catch(1),
  source: z.string().max(200_000).default(""),
});

export const createReplyAction = defineAction({
  name: "reply.create",
  auth: "user",
  input: createReplyInput,
  async run(ctx, input) {
    const r = await createReply(ctx.subject, { threadId: input.threadId, source: input.source });
    if (!r.ok) redirect(`/t/${input.threadId}?page=${input.page}&reply=${r.code}#reply`);
    // 跳转目标与当前页同路径（只差 #锚点）时，客户端会复用缓存的旧内容，新回复看不到：先让该主题的缓存失效
    revalidatePath(`/t/${input.threadId}`);
    const loc = await locatePost(ctx.subject, r.postId);
    redirect(loc ? postPath(loc) : `/t/${input.threadId}`);
  },
});
