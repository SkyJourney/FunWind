"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AdminError } from "@/lib/authz/admin";
import { defineAction } from "@/lib/actions/define-action";
import { deleteMessage } from "@/lib/pm/admin";

/** 私信管理 Server Actions（M10 补做）：删除违规消息（审计）。禁止发私信走用户管理页的限制（mute）。 */

const deleteInput = z.object({
  messageId: z.coerce.number().int().positive(),
  reason: z.string().max(500).default(""),
});

export const deleteMessageAction = defineAction({
  name: "admin.pm.delete_message",
  auth: { admin: "site.admin" },
  input: deleteInput,
  async run(ctx, input) {
    try {
      await deleteMessage(
        { userId: ctx.userId ?? 0, via: "admin", ip: ctx.ip },
        input.messageId,
        input.reason,
      );
    } catch (e) {
      if (e instanceof AdminError) redirect(`/admin/pm?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    revalidatePath("/admin/pm");
    redirect("/admin/pm?deleted=1");
  },
});
