import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { validateTaskKey } from "@/lib/ops/executors";
import { parseManageWrite } from "@/lib/manage/write-request";
import { commitWrite } from "@/lib/manage/content-writes";
import { OPS_DENIAL_HTTP, prepareApiOpsTaskUpdate } from "@/lib/ops/api-writes";

export const dynamic = "force-dynamic";

const BODY = z.strictObject({
  expectedRevision: z.number().int().min(1),
  name: z.string().trim().min(1).max(60).optional(),
  params: z.unknown().optional(),
});

export const PATCH = manageEndpoint(
  async (ctx) => {
    const { taskKey } = await ctx.params;
    if (typeof taskKey !== "string" || !validateTaskKey(taskKey).ok) {
      throw new ManageApiError("not_found");
    }
    const { targetId, idempotencyKey, input } = await parseManageWrite(ctx, BODY);
    const actor = { userId: ctx.token.userId, ip: ctx.ip, via: "api" as const };
    const trace = { requestId: ctx.requestId, tokenSuffix: ctx.token.suffix };
    return manageOk(
      await commitWrite(
        ctx,
        "ops.params",
        { targetId, idempotencyKey, input: { ...input, taskKey } },
        prepareApiOpsTaskUpdate(
          actor,
          taskKey,
          input.expectedRevision,
          { name: input.name, params: input.params },
          trace,
        ),
        OPS_DENIAL_HTTP,
      ),
    );
  },
  { endpoint: "ops.params" },
);
