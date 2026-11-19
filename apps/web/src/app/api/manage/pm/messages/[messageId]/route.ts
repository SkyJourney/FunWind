import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { deleteManagePmMessage, managePmDeleteInput } from "@/lib/manage/community-writes";

export const dynamic = "force-dynamic";

/** DELETE /api/manage/pm/messages/{messageId}：管理员删除私信（软删覆写+理由入审计），幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, managePmDeleteInput, "messageId");
    return manageOk(await deleteManagePmMessage(ctx, params));
  },
  { endpoint: "pm.message-delete" },
);
