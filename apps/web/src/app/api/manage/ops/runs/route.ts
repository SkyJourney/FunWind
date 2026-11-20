import "@/modules";
import { z } from "zod";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";
import { managePageField, manageSizeField } from "@/lib/manage/params";
import { listOpsRunPage } from "@/lib/ops/runs";

export const dynamic = "force-dynamic";

const querySchema = z.object({ page: managePageField(), size: manageSizeField() });

/** GET /api/manage/ops/runs：运行历史分页（原生 SQL 台账） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    const result = await listOpsRunPage(q.page ?? 1, q.size !== 20 ? q.size : undefined);
    return manageOk(result);
  },
  { endpoint: "ops.runs" },
);
