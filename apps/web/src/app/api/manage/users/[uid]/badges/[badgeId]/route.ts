import "@/modules";
import { z } from "zod";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { grantManageBadge, revokeManageBadge } from "@/lib/manage/asset-writes";

export const dynamic = "force-dynamic";

/** POST /api/manage/users/{uid}/badges/{badgeId}：授予徽章（通知当事人），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, z.strictObject({}), "uid");
    const raw = (await ctx.params).badgeId;
    const badgeId = Array.isArray(raw) ? raw[0] : raw;
    if (typeof badgeId !== "string" || !/^\d+$/.test(badgeId) || Number(badgeId) <= 0) {
      const err = new (await import("@/lib/manage/errors")).ManageApiError("not_found");
      throw err;
    }
    return manageOk(
      await grantManageBadge(ctx, {
        uid: params.targetId,
        badgeId: Number(badgeId),
        idempotencyKey: params.idempotencyKey,
      }),
    );
  },
  { endpoint: "badges.grant" },
);

/** DELETE /api/manage/users/{uid}/badges/{badgeId}：撤销徽章（通知当事人），幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, z.strictObject({}), "uid");
    const raw = (await ctx.params).badgeId;
    const badgeId = Array.isArray(raw) ? raw[0] : raw;
    if (typeof badgeId !== "string" || !/^\d+$/.test(badgeId) || Number(badgeId) <= 0) {
      const err = new (await import("@/lib/manage/errors")).ManageApiError("not_found");
      throw err;
    }
    return manageOk(
      await revokeManageBadge(ctx, {
        uid: params.targetId,
        badgeId: Number(badgeId),
        idempotencyKey: params.idempotencyKey,
      }),
    );
  },
  { endpoint: "badges.revoke" },
);
