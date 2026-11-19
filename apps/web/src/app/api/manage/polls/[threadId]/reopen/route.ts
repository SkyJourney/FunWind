import "@/modules";
import { z } from "zod";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { reopenManagePoll } from "@/lib/manage/community-writes";

export const dynamic = "force-dynamic";

/** POST /api/manage/polls/{threadId}/reopen：重开投票，幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, z.strictObject({}), "threadId");
    return manageOk(await reopenManagePoll(ctx, params));
  },
  { endpoint: "polls.reopen" },
);
