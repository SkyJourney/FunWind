import "@/modules";
import { manageRestrictionInput, restrictManageUser } from "@/lib/manage/user-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";

export const dynamic = "force-dynamic";

/** POST /api/manage/users/{uid}/restrictions：创建限制（五类，全站或版块作用域），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageRestrictionInput, "uid");
    return manageOk(await restrictManageUser(ctx, params));
  },
  { endpoint: "users.restrict" },
);
