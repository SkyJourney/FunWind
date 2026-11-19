import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { manageEmojiEnabledInput, toggleManageEmojiGroup } from "@/lib/manage/asset-writes";

export const dynamic = "force-dynamic";

/** POST /api/manage/emoji-groups/{groupId}/enabled：组启停（停用不影响已发布正文），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageEmojiEnabledInput, "groupId");
    return manageOk(await toggleManageEmojiGroup(ctx, params));
  },
  { endpoint: "emojis.group-enabled" },
);
