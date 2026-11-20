import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { validateTaskKey } from "@/lib/ops/executors";
import { readManageJson } from "@/lib/manage/write-request";
import { triggerManageOpsTask } from "@/lib/ops/api-writes";

export const dynamic = "force-dynamic";

const BODY = z.strictObject({});
const FAILURE = {
  "not-found": "not_found",
  disabled: "state_conflict",
  busy: "state_conflict",
  rejected: "bad_request",
  unconfigured: "ops_unavailable",
  unavailable: "ops_unavailable",
  unauthorized: "ops_unavailable",
  failed: "ops_unavailable",
} as const;

/** 手动触发在通用写门禁内受理，调用不进入事务幂等缓存。 */
export const POST = manageEndpoint(
  async (ctx) => {
    const { taskKey } = await ctx.params;
    if (typeof taskKey !== "string" || !validateTaskKey(taskKey).ok) {
      throw new ManageApiError("not_found");
    }
    BODY.parse(await readManageJson(ctx.request));
    const actor = { userId: ctx.token.userId, ip: ctx.ip, via: "api" as const };
    const trace = { requestId: ctx.requestId, tokenSuffix: ctx.token.suffix };
    const result = await triggerManageOpsTask(actor, taskKey, trace);
    if (!result.ok) throw new ManageApiError(FAILURE[result.code]);
    return manageOk({ taskKey, runId: result.runId, accepted: true }, 202);
  },
  { endpoint: "ops.trigger" },
);
