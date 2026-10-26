"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { vote } from "@/lib/poll/service";

/**
 * 投票 Server Action（M10）：optionIds 支持两种表单形态——
 *  · 多个同名键（多选 checkbox，FormData 归并为 string[]）；
 *  · 单个逗号分隔串（string，程序化提交）。
 * 失败带固定码回帖子页投票块（?vote=）。无法解析 → notFound（与其它 action 的畸形输入口径一致）。
 */
const optionIdsField = z.union([z.string(), z.array(z.string())]).transform((v) => {
  const raw = Array.isArray(v) ? v : v.split(",");
  return raw
    .flatMap((x) => x.split(","))
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0);
});

const voteInput = z.object({
  threadId: z.coerce.number().int().positive(),
  optionIds: optionIdsField,
});

export const voteAction = defineAction({
  name: "poll.vote",
  auth: "user",
  input: voteInput,
  async run(ctx, input) {
    const optionIds = input.optionIds;
    const r = await vote(ctx.subject, input.threadId, optionIds);
    if (!r.ok) {
      redirect(`/t/${input.threadId}?vote=${encodeURIComponent(r.code)}`);
    }
    revalidatePath(`/t/${input.threadId}`);
    redirect(`/t/${input.threadId}#poll`);
  },
});
