import "@/modules";
import { manageThreadLockInput, setManageThreadLock } from "@/lib/manage/content-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";

export const dynamic = "force-dynamic";

export const PUT = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageThreadLockInput, "threadId");
    return manageOk(await setManageThreadLock(ctx, params));
  },
  { endpoint: "threads.lock" },
);
