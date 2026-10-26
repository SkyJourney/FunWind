"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { sendMessage } from "@/lib/pm/service";

/** 私信 Server Action（M10）：失败带码回跳（错误码走 URL，不带正文）。 */

const sendInput = z.object({
  recipientId: z.coerce.number().int().positive(),
  body: z.string().max(5000).default(""),
  back: z.string().max(200).default("/messages"),
});

export const sendMessageAction = defineAction({
  name: "pm.send",
  auth: "user",
  input: sendInput,
  async run(ctx, input) {
    const r = await sendMessage(ctx.subject, input.recipientId, input.body);
    // 失败回跳保留 to 参数（发起新会话表单在 /messages?to=）
    const back = input.back.startsWith("/")
      ? input.back
      : `/messages${input.recipientId ? `?to=${input.recipientId}` : ""}`;
    if (!r.ok) {
      redirect(`${back}?pm=${encodeURIComponent(r.code)}`);
    }
    revalidatePath("/messages");
    redirect(`/messages/${r.conversationId}`);
  },
});
