import "@/modules";
import { manageThreadFlagsInput, setManageThreadFlags } from "@/lib/manage/content-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";

export const dynamic = "force-dynamic";

/** PATCH /api/manage/threads/{threadId}/flags：主题精华/置顶（锁定请用 /lock） */
export const PATCH = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageThreadFlagsInput, "threadId");
    return manageOk(await setManageThreadFlags(ctx, params));
  },
  { endpoint: "threads.flags" },
);
