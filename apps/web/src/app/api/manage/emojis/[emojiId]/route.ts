import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { manageEmojiUpdateInput, updateManageEmoji } from "@/lib/manage/asset-writes";

export const dynamic = "force-dynamic";

/** PATCH /api/manage/emojis/{emojiId}：更新表情元数据（值未变零审计），幂等写 */
export const PATCH = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageEmojiUpdateInput, "emojiId");
    return manageOk(await updateManageEmoji(ctx, params));
  },
  { endpoint: "emojis.update" },
);
