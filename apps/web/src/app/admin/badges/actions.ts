"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AdminError } from "@/lib/authz/admin";
import { defineAction } from "@/lib/actions/define-action";
import { grantBadgeByAdmin } from "@/lib/badges/service";
import { findUserIdByName } from "@/lib/queries/users";

/** 徽章授予 Server Action（M7，`admin.badges`）：重复授予由联合主键兜底，授予出审计与 badge.awarded 事件 */
const grantInput = z.object({
  username: z.string().trim().min(1).max(64),
  badgeId: z.coerce.number().int().positive(),
});

export const grantBadgeAction = defineAction({
  name: "admin.badge.grant",
  auth: { admin: "admin.badges" },
  input: grantInput,
  async run(ctx, input) {
    let userId: number | null;
    try {
      userId = await findUserIdByName(input.username);
      if (userId === null) throw new AdminError(`用户不存在或已注销：${input.username}`);
      await grantBadgeByAdmin(
        { userId: ctx.admin!.userId, via: "admin", ip: ctx.admin!.ip },
        { userId, badgeId: input.badgeId },
      );
    } catch (e) {
      if (e instanceof AdminError) redirect(`/admin/badges?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    revalidatePath("/admin/badges");
    revalidatePath(`/u/${userId}`);
    redirect(`/admin/badges?granted=1&uid=${userId}`);
  },
});
