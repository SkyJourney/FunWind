"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { dismissReportsBulk, handleReport } from "@/lib/reports/service";

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

// —— 批量忽略（M9.5）：checkbox 多选，说明统一「经核实不构成违规」，逐条独立事务 ——

const dismissBulkInput = z.object({
  reportIds: z.preprocess(
    (v) => (Array.isArray(v) ? v : [v]),
    z.array(z.coerce.number().int().positive()).min(1).max(100),
  ),
});

export const dismissReportBulkAction = defineAction({
  name: "admin.report.dismiss_bulk",
  auth: { admin: "admin.reports" },
  input: dismissBulkInput,
  async run(ctx, input) {
    const r = await dismissReportsBulk(
      { userId: ctx.userId ?? 0, via: "admin", ip: ctx.ip },
      input.reportIds,
    );
    revalidatePath("/admin/reports");
    if (r.failed > 0) {
      redirect(
        `/admin/reports?error=${encodeURIComponent(`批量忽略：成功 ${r.ok} 条，跳过 ${r.failed} 条（已处理或不存在）`)}`,
      );
    }
    redirect(`/admin/reports?dismissed=${r.ok}`);
  },
});
