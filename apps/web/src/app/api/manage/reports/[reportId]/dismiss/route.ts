import "@/modules";
import { dismissManageReport, manageReportHandleInput } from "@/lib/manage/report-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";

export const dynamic = "force-dynamic";

/** POST /api/manage/reports/{reportId}/dismiss：忽略举报（pending→dismissed），说明必填 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageReportHandleInput, "reportId");
    return manageOk(await dismissManageReport(ctx, params));
  },
  { endpoint: "reports.dismiss" },
);
