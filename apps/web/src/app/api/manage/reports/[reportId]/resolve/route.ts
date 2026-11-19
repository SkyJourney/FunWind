import "@/modules";
import { manageReportHandleInput, resolveManageReport } from "@/lib/manage/report-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";

export const dynamic = "force-dynamic";

/** POST /api/manage/reports/{reportId}/resolve：处置举报（pending→resolved），说明必填并反馈举报人 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageReportHandleInput, "reportId");
    return manageOk(await resolveManageReport(ctx, params));
  },
  { endpoint: "reports.resolve" },
);
