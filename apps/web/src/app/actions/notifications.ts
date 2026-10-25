"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { markRead } from "@/lib/notifications/queries";
import { redirect } from "next/navigation";

/**
 * 通知页的标记已读（M8）：单条（点击通知行）/ 全部。公告行标记为读公告。
 * 铃铛面板的批量已读走 /api/notifications/read（同语义）。
 */

const oneInput = z.object({
  kind: z.enum(["notification", "announcement"]),
  id: z.coerce.number().int().positive(),
  back: z.string().max(200).default("/notifications"),
});

export const markOneReadAction = defineAction({
  name: "notifications.read_one",
  auth: "user",
  input: oneInput,
  async run(ctx, input) {
    if (input.kind === "notification") {
      await markRead(ctx.userId!, { ids: [input.id] });
    } else {
      await markRead(ctx.userId!, { category: "announcement" });
    }
    revalidatePath("/notifications");
    revalidatePath("/");
    redirect(input.back.startsWith("/") ? input.back : "/notifications");
  },
});

const allInput = z.object({ back: z.string().max(200).default("/notifications") });
export const markAllReadAction = defineAction({
  name: "notifications.read_all",
  auth: "user",
  input: allInput,
  async run(ctx, input) {
    await markRead(ctx.userId!, { all: true });
    revalidatePath("/notifications");
    revalidatePath("/");
    redirect(input.back.startsWith("/") ? input.back : "/notifications");
  },
});
