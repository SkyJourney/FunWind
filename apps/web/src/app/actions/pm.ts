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
    const back =
      input.back.startsWith("/") && !input.back.startsWith("//") && !input.back.includes("\\")
        ? input.back
        : `/messages${input.recipientId ? `?to=${input.recipientId}` : ""}`;
    if (!r.ok) {
      const url = new URL(back, "http://localhost");
      url.searchParams.set("pm", r.code);
      redirect(`${url.pathname}${url.search}${url.hash}`);
    }
    revalidatePath("/messages");
    redirect(`/messages/${r.conversationId}`);
  },
});

const policyInput = z.object({
  policy: z.enum(["all", "following", "off"]),
  back: z.string().max(200).default("/me"),
});

/** 本人私信权限偏好（M10.5 功能补全）：唯一写路径；判定在 pm service。 */
export const updatePmPolicyAction = defineAction({
  name: "pm.policy.update",
  auth: "user",
  input: policyInput,
  async run(ctx, input) {
    const { getWebDb, userProfiles } = await import("@funwind/db");
    const { eq } = await import("drizzle-orm");
    await getWebDb()
      .update(userProfiles)
      .set({ pmPolicy: input.policy })
      .where(eq(userProfiles.userId, ctx.subject.userId!));
    revalidatePath("/me");
    redirect(input.back);
  },
});
