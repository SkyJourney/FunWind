"use server";

import { defineAction } from "@/lib/actions/define-action";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { generateInvites, revokeInvite } from "@/lib/admin/invites";

/** 邀请码管理动作（M10.6b）：门禁 site.admin；生成/撤销均写审计（invites 服务内随事务）。 */

const ERR_HOP = (code: string) => `/admin/invites?err=${encodeURIComponent(code)}`;

export const generateInvitesAction = defineAction({
  name: "admin.invite.generate",
  auth: { admin: "site.admin" },
  input: z.object({
    count: z.coerce.number().int().min(1).max(20),
    // 有效天数；0 = 永不过期
    days: z.coerce.number().int().min(0).max(3650).default(30),
    batch: z.string().trim().max(64).default(""),
  }),
  async run(ctx, input) {
    await generateInvites({ userId: ctx.userId, ip: ctx.ip }, input);
    revalidatePath("/admin/invites");
    redirect("/admin/invites?saved=1");
  },
});

export const revokeInviteAction = defineAction({
  name: "admin.invite.revoke",
  auth: { admin: "site.admin" },
  input: z.object({ code: z.string().min(1).max(32) }),
  async run(ctx, input) {
    const r = await revokeInvite({ userId: ctx.userId, ip: ctx.ip }, input.code);
    if (!r.ok) redirect(ERR_HOP(r.code));
    revalidatePath("/admin/invites");
    redirect("/admin/invites");
  },
});
