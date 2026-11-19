import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { revokeManageInviteBatch } from "@/lib/manage/ops-writes";

export const dynamic = "force-dynamic";

/** 路径 batch 形态判定（≤64 列宽）：不符按不存在处理。 */
async function requireBatch(ctx: ManageHandlerContext): Promise<string> {
  const { batch } = await ctx.params;
  if (typeof batch !== "string" || batch.length === 0 || batch.length > 64) {
    throw new ManageApiError("not_found");
  }
  return batch;
}

/** POST 请求体保持空对象：batch 由路径注入参与幂等指纹。 */
const batchBody = z.strictObject({});

/** POST /api/manage/invites/batches/{batch}/revoke：吊销批次全部可用码，幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const batch = await requireBatch(ctx);
    const params = await parseManageWrite(ctx, batchBody);
    void params.targetId;
    return manageOk(
      await revokeManageInviteBatch(ctx, {
        targetId: 0,
        idempotencyKey: params.idempotencyKey,
        input: { batch },
      }),
    );
  },
  { endpoint: "invites.revoke-batch" },
);
