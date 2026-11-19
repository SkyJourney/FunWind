import "@/modules";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { editManageCampaign, manageCampaignEditInput } from "@/lib/manage/ops-writes";
import { getCampaign } from "@/lib/campaigns/list";

export const dynamic = "force-dynamic";

/** GET /api/manage/campaigns/{campaignId}：活动单条详情（与列表同口径映射；不存在 404） */
export const GET = manageEndpoint(
  async ({ params }) => {
    const { campaignId } = await params;
    const raw = Array.isArray(campaignId) ? campaignId[0] : campaignId;
    if (!/^\d+$/.test(raw ?? "")) throw new ManageApiError("not_found");
    const detail = await getCampaign(Number(raw));
    if (!detail) throw new ManageApiError("not_found");
    return manageOk(detail);
  },
  { endpoint: "campaigns.detail" },
);

/** PATCH /api/manage/campaigns/{campaignId}：编辑活动（expectedRevision 不一致 409），幂等写 */
export const PATCH = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageCampaignEditInput, "campaignId");
    return manageOk(await editManageCampaign(ctx, params));
  },
  { endpoint: "campaigns.edit" },
);
