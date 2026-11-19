import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import {
  deleteManageEmojiGroup,
  manageEmojiGroupDeleteInput,
  manageEmojiGroupRenameInput,
  renameManageEmojiGroup,
} from "@/lib/manage/asset-writes";

export const dynamic = "force-dynamic";

/** PATCH /api/manage/emoji-groups/{groupId}：组改名（重名 409），幂等写 */
export const PATCH = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageEmojiGroupRenameInput, "groupId");
    return manageOk(await renameManageEmojiGroup(ctx, params));
  },
  { endpoint: "emojis.group-rename" },
);

/** DELETE /api/manage/emoji-groups/{groupId}：删除空表情组（非空 409），幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageEmojiGroupDeleteInput, "groupId");
    return manageOk(await deleteManageEmojiGroup(ctx, params));
  },
  { endpoint: "emojis.group-delete" },
);
