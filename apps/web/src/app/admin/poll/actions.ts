"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AdminError } from "@/lib/authz/admin";
import { defineAction } from "@/lib/actions/define-action";
import { closePoll, deletePoll } from "@/lib/poll/admin";

/** 投票管理 Server Actions（M10 补做）：关闭/删除。权限在服务层（site.admin 全站 / 版主所辖版块）。 */

const pollInput = z.object({ pollId: z.coerce.number().int().positive() });

export const closePollAction = defineAction({
  name: "admin.poll.close",
  auth: "user",
  input: pollInput,
  async run(ctx, input) {
    try {
      await closePoll({ userId: ctx.userId ?? 0, via: "admin", ip: ctx.ip }, input.pollId);
    } catch (e) {
      if (e instanceof AdminError) redirect(`/admin/poll?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    revalidatePath("/admin/poll");
    redirect("/admin/poll?closed=1");
  },
});

export const deletePollAction = defineAction({
  name: "admin.poll.delete",
  auth: "user",
  input: pollInput,
  async run(ctx, input) {
    try {
      await deletePoll({ userId: ctx.userId ?? 0, via: "admin", ip: ctx.ip }, input.pollId);
    } catch (e) {
      if (e instanceof AdminError) redirect(`/admin/poll?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    revalidatePath("/admin/poll");
    revalidatePath(`/t/0`); // 主题页按 id revalidate 由主题页 force-dynamic 兜底
    redirect("/admin/poll?deleted=1");
  },
});
