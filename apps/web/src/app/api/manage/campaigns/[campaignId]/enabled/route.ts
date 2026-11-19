import "@/modules";
import { manageCampaignEnabledInput, toggleManageCampaign } from "@/lib/manage/ops-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";

export const dynamic = "force-dynamic";

/** POST /api/manage/campaigns/{campaignId}/enabled：启停活动（同值 changed:false），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageCampaignEnabledInput, "campaignId");
    return manageOk(await toggleManageCampaign(ctx, params));
  },
  { endpoint: "campaigns.enabled" },
);
