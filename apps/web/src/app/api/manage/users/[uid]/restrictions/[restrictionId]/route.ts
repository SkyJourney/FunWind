import "@/modules";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { liftManageRestriction, manageRestrictionLiftInput } from "@/lib/manage/user-writes";
import type { ManageHandlerContext } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

/** 严格十进制路径 uid：畸形输入与不存在同型 404（对齐 users.detail 口径）。 */
async function requireUid(ctx: ManageHandlerContext): Promise<number> {
  const { uid } = await ctx.params;
  if (typeof uid !== "string" || !/^\d+$/.test(uid)) throw new ManageApiError("not_found");
  const value = Number(uid);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ManageApiError("not_found");
  return value;
}

/** DELETE /api/manage/users/{uid}/restrictions/{restrictionId}：解除限制（说明必填），幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const uid = await requireUid(ctx);
    const params = await parseManageWrite(ctx, manageRestrictionLiftInput, "restrictionId");
    return manageOk(await liftManageRestriction(ctx, { ...params, uid }));
  },
  { endpoint: "users.lift" },
);
