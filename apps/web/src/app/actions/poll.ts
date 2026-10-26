"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { vote } from "@/lib/poll/service";

/** 投票 Server Action（M10）：optionIds 逗号分隔；失败带码回帖子页投票块。 */

const voteInput = z.object({
  threadId: z.coerce.number().int().positive(),
  optionIds: z.string().max(200).default(""),
});

export const voteAction = defineAction({
  name: "poll.vote",
  auth: "user",
  input: voteInput,
  async run(ctx, input) {
    const optionIds = input.optionIds
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v) && v > 0);
    const r = await vote(ctx.subject, input.threadId, optionIds);
    if (!r.ok) {
      redirect(`/t/${input.threadId}?vote=${encodeURIComponent(r.code)}`);
    }
    revalidatePath(`/t/${input.threadId}`);
    redirect(`/t/${input.threadId}#poll`);
  },
});
