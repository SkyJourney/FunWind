"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { handleReport } from "@/lib/reports/service";

/** 举报处理 Server Actions（M9，admin.reports）：resolved（已处置）/ dismissed（忽略），说明必填。 */

const handleInput = z.object({
  reportId: z.coerce.number().int().positive(),
  outcome: z.enum(["resolved", "dismissed"]),
  note: z.string().max(500).default(""),
});

export const handleReportAction = defineAction({
  name: "admin.report.handle",
  auth: { admin: "admin.reports" },
  input: handleInput,
  async run(ctx, input) {
    const r = await handleReport(
      { userId: ctx.userId ?? 0, via: "admin", ip: ctx.ip },
      input.reportId,
      input.outcome,
      input.note,
    );
    if (!r.ok) {
      const msg = r.code === "note_required" ? "必须填写处理说明" : "举报不存在或已处理";
      redirect(`/admin/reports?error=${encodeURIComponent(msg)}`);
    }
    revalidatePath("/admin/reports");
    redirect(`/admin/reports?${input.outcome}=1`);
  },
});
