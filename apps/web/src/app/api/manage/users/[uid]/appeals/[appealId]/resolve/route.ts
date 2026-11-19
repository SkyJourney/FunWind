import "@/modules";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { manageAppealResolveInput, resolveManageUserAppeal } from "@/lib/manage/user-writes";
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

/** POST /api/manage/users/{uid}/appeals/{appealId}/resolve：申诉处置（approved/rejected），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const uid = await requireUid(ctx);
    const params = await parseManageWrite(ctx, manageAppealResolveInput, "appealId");
    return manageOk(await resolveManageUserAppeal(ctx, { ...params, uid }));
  },
  { endpoint: "users.resolve-appeal" },
);
