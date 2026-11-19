import "@/modules";
import { loadReportDetail } from "@/lib/reports/service";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

/** GET /api/manage/reports/{reportId}：举报详情（报告行 + 被举报帖摘要 + 处置记录） */
export const GET = manageEndpoint(
  async ({ params }) => {
    const { reportId } = await params;
    const raw = Array.isArray(reportId) ? reportId[0] : reportId;
    // 严格十进制判定：与 users.detail 同口径，畸形输入一律 404
    if (!/^\d+$/.test(raw ?? "")) throw new ManageApiError("not_found");
    const detail = await loadReportDetail(Number(raw));
    if (!detail) throw new ManageApiError("not_found");
    return manageOk(detail);
  },
  { endpoint: "reports.detail" },
);
