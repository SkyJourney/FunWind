import "@/modules";
import { createManageCampaign, manageCampaignInput } from "@/lib/manage/ops-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { listCampaigns } from "@/lib/campaigns/list";

export const dynamic = "force-dynamic";

/** GET /api/manage/campaigns：活动方案列表（与后台列表同一读取链，不分页） */
export const GET = manageEndpoint(
  async () => {
    const result = await listCampaigns();
    return manageOk(result);
  },
  { endpoint: "campaigns" },
);

/** POST /api/manage/campaigns：创建活动方案（enabled 恒 true、revision=1），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageCampaignInput);
    return manageOk(await createManageCampaign(ctx, params));
  },
  { endpoint: "campaigns.create" },
);
