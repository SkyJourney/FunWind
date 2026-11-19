import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { manageEmojiEnabledInput, toggleManageEmoji } from "@/lib/manage/asset-writes";

export const dynamic = "force-dynamic";

/** POST /api/manage/emojis/{emojiId}/enabled：表情启停（同值零审计），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageEmojiEnabledInput, "emojiId");
    return manageOk(await toggleManageEmoji(ctx, params));
  },
  { endpoint: "emojis.enabled" },
);
