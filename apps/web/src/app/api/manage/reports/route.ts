import "@/modules";
import { z } from "zod";
import { listReportsPage } from "@/lib/reports/service";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";
import { managePageField, manageSizeField } from "@/lib/manage/params";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["pending", "resolved", "dismissed"]).optional(),
  targetType: z.string().max(32).optional(),
  page: managePageField(),
  size: manageSizeField(),
});

/** GET /api/manage/reports：举报列表（状态/目标类型筛选，与后台举报页同源查询） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    const result = await listReportsPage(
      { status: q.status, targetType: q.targetType },
      q.page ?? 1,
      q.size !== 20 ? q.size : undefined,
    );
    return manageOk(result);
  },
  { endpoint: "reports" },
);
