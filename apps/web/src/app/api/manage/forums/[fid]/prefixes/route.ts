import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { addManageForumPrefix, manageForumPrefixInput } from "@/lib/manage/community-writes";

export const dynamic = "force-dynamic";

/** POST /api/manage/forums/{fid}/prefixes：添加版块前缀，幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageForumPrefixInput, "fid");
    return manageOk(await addManageForumPrefix(ctx, params));
  },
  { endpoint: "forums.prefix-add" },
);
