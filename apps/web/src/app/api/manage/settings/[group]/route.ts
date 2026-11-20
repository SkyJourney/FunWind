import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { updateManageSettings } from "@/lib/manage/system-writes";

export const dynamic = "force-dynamic";

const BODY = z.unknown();

async function requireGroup(ctx: ManageHandlerContext): Promise<string> {
  const raw = (await ctx.params).group;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^[a-z.]+$/.test(value)) {
    throw new ManageApiError("not_found");
  }
  return value;
}

/** PATCH /api/manage/settings/{group}：更新设置分组（白名单+zod，无乐观锁），幂等写 */
export const PATCH = manageEndpoint(
  async (ctx) => {
    const group = await requireGroup(ctx);
    const params = await parseManageWrite(ctx, BODY);
    return manageOk(
      await updateManageSettings(ctx, {
        targetId: params.targetId,
        idempotencyKey: params.idempotencyKey,
        input: params.input,
        group,
      }),
    );
  },
  { endpoint: "settings.update" },
);
