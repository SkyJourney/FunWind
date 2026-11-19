import "@/modules";
import { z } from "zod";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { deleteManagePoll } from "@/lib/manage/community-writes";

export const dynamic = "force-dynamic";

/** DELETE /api/manage/polls/{threadId}：删除投票（硬删选项与选票），幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, z.strictObject({}), "threadId");
    return manageOk(await deleteManagePoll(ctx, params));
  },
  { endpoint: "polls.delete" },
);
