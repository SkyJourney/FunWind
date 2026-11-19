import "@/modules";
import { disableManagePost, managePostActionInput } from "@/lib/manage/content-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";

export const dynamic = "force-dynamic";

/** POST /api/manage/posts/{postId}/disable：封禁内容（→disabled），理由必填 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, managePostActionInput, "postId");
    return manageOk(await disableManagePost(ctx, params));
  },
  { endpoint: "posts.disable" },
);
