"use server";

import { defineAction } from "@/lib/actions/define-action";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { generateInvites, revokeInvite, revokeInvitesByBatch } from "@/lib/admin/invites";

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
    // 带批次回跳：列表按批次筛选并高亮，新码可直接定位与复制（M9.5）
    const batchQ = input.batch ? `&batch=${encodeURIComponent(input.batch)}` : "";
    redirect(`/admin/invites?saved=${input.count}${batchQ}`);
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

/** 按批次撤销全部可用码（M9.5 批量撤销）：批次无可用码时回 not_found */
export const revokeInviteBatchAction = defineAction({
  name: "admin.invite.revoke_batch",
  auth: { admin: "site.admin" },
  input: z.object({ batch: z.string().trim().min(1).max(64) }),
  async run(ctx, input) {
    const r = await revokeInvitesByBatch({ userId: ctx.userId, ip: ctx.ip }, input.batch);
    if (!r.ok) redirect(ERR_HOP("not_found"));
    revalidatePath("/admin/invites");
    redirect(`/admin/invites?revoked=${r.revoked}&batch=${encodeURIComponent(input.batch)}`);
  },
});
