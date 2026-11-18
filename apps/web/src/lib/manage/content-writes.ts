import "server-only";

import { z } from "zod";
import type { ConfigActor, DbTx } from "@/lib/audit";
import { isValidBeijingDateTime } from "@/lib/datetime";
import { ManageApiError } from "@/lib/manage/errors";
import { runIdempotentManageWrite } from "@/lib/manage/idempotency";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { prepareApiThreadLock } from "@/lib/moderation/contents";
import { prepareApiReview } from "@/lib/moderation/review";

const expectedEditedAt = z.string().refine(isValidBeijingDateTime).nullable();

export const manageReviewInput = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("approve"), expectedEditedAt }),
  z.strictObject({
    decision: z.literal("reject"),
    expectedEditedAt,
    reason: z.string().trim().min(1).max(255),
  }),
]);

export const manageThreadLockInput = z.strictObject({ locked: z.boolean() });

type WriteInput<T> = { targetId: number; idempotencyKey: string; input: T };
type WriteDenial = { ok: false; code: string };
type ExecutedWrite = { ok: true; data: object; afterCommit?: () => Promise<void> };
type PreparedWrite = {
  ok: true;
  lock(
    tx: DbTx,
  ): Promise<{ ok: true; execute(): Promise<ExecutedWrite | WriteDenial> } | WriteDenial>;
};

/** 资源权限与不存在同型。未知业务错误由入口兜底，不透出服务文本。 */
function requireSuccess<T extends { ok: true }>(result: T | WriteDenial): T {
  if (result.ok) return result;
  switch (result.code) {
    case "not_found":
    case "forbidden":
      throw new ManageApiError("not_found");
    case "bad_state":
    case "conflict":
      throw new ManageApiError("state_conflict");
    case "bad_reason":
    case "reason_required":
    case "reason_too_long":
      throw new ManageApiError("bad_request");
    default:
      throw new ManageApiError("internal");
  }
}

function auditContext(ctx: ManageHandlerContext) {
  const actor: ConfigActor = { userId: ctx.token.userId, ip: ctx.ip, via: "api" };
  return { actor, trace: { requestId: ctx.requestId, tokenSuffix: ctx.token.suffix } };
}

async function commitWrite(
  ctx: ManageHandlerContext,
  endpoint: "posts.review" | "threads.lock",
  params: WriteInput<Record<string, unknown>>,
  preparation: Promise<PreparedWrite | WriteDenial>,
): Promise<unknown> {
  const operation = requireSuccess(await preparation);
  return runIdempotentManageWrite(
    {
      tokenId: ctx.token.id,
      endpoint,
      idempotencyKey: params.idempotencyKey,
      requestId: ctx.requestId,
    },
    params.targetId,
    params.input,
    async (tx) => {
      const locked = requireSuccess(await operation.lock(tx));
      return async () => requireSuccess(await locked.execute());
    },
  );
}

export function reviewManagePost(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageReviewInput>>,
) {
  const { actor, trace } = auditContext(ctx);
  return commitWrite(
    ctx,
    "posts.review",
    params,
    prepareApiReview(ctx.subject, params.targetId, params.input, actor, trace),
  );
}

export function setManageThreadLock(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageThreadLockInput>>,
) {
  const { actor, trace } = auditContext(ctx);
  return commitWrite(
    ctx,
    "threads.lock",
    params,
    prepareApiThreadLock(ctx.subject, params.targetId, params.input.locked, actor, trace),
  );
}
