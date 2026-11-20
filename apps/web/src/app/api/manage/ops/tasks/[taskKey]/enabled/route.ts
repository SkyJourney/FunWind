import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { validateTaskKey } from "@/lib/ops/executors";
import { parseManageWrite } from "@/lib/manage/write-request";
import { commitWrite } from "@/lib/manage/content-writes";
import { OPS_DENIAL_HTTP, prepareApiOpsTaskEnabled } from "@/lib/ops/api-writes";

export const dynamic = "force-dynamic";

const BODY = z.strictObject({ enabled: z.boolean() });

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
        "ops.enabled",
        { targetId, idempotencyKey, input: { ...input, taskKey } },
        prepareApiOpsTaskEnabled(actor, taskKey, input.enabled, trace),
        OPS_DENIAL_HTTP,
      ),
    );
  },
  { endpoint: "ops.enabled" },
);
