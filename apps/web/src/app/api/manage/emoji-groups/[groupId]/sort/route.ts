import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { manageEmojiGroupReorderInput, reorderManageEmojiGroup } from "@/lib/manage/asset-writes";

export const dynamic = "force-dynamic";

/** POST /api/manage/emoji-groups/{groupId}/sort：组排序（同值零审计），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageEmojiGroupReorderInput, "groupId");
    return manageOk(await reorderManageEmojiGroup(ctx, params));
  },
  { endpoint: "emojis.group-reorder" },
);
