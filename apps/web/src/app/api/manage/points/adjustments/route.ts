import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { adjustManagePoints, managePointsAdjustInput } from "@/lib/manage/asset-writes";

export const dynamic = "force-dynamic";

/** POST /api/manage/points/adjustments：手工调账（adjust.admin 渠道，台账同事务），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, managePointsAdjustInput);
    void params.targetId;
    return manageOk(await adjustManagePoints(ctx, params));
  },
  { endpoint: "points.adjust" },
);
