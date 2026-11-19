import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { createManageEmojiGroup, manageEmojiGroupCreateInput } from "@/lib/manage/asset-writes";

export const dynamic = "force-dynamic";

/** POST /api/manage/emoji-groups：创建表情组（组名唯一），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageEmojiGroupCreateInput);
    void params.targetId;
    return manageOk(await createManageEmojiGroup(ctx, params));
  },
  { endpoint: "emojis.group-create" },
);
