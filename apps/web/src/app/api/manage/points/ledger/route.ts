import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";
import { managePageField, manageSizeField } from "@/lib/manage/params";
import { getLedgerPage } from "@/lib/points/ledger";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  userId: z.coerce.number().int().min(1),
  page: managePageField(),
  size: manageSizeField(),
});

/** GET /api/manage/points/ledger?userId=：积分余额快照与台账分页（只增不改不删） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    if (!q.userId) throw new ManageApiError("bad_request");
    return manageOk(await getLedgerPage(q.userId, q.page ?? 1));
  },
  { endpoint: "points.ledger" },
);
