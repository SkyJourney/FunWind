import "@/modules";
import { managePostRestoreInput, restoreManagePost } from "@/lib/manage/content-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";

export const dynamic = "force-dynamic";

/** POST /api/manage/posts/{postId}/restore：版主恢复已删内容（deleted→visible） */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, managePostRestoreInput, "postId");
    return manageOk(await restoreManagePost(ctx, params));
  },
  { endpoint: "posts.restore" },
);
