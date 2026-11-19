import "server-only";

import { z } from "zod";
import type { ConfigActor, DbTx } from "@/lib/audit";
import { isValidBeijingDateTime } from "@/lib/datetime";
import { ManageApiError, type ManageErrorCode } from "@/lib/manage/errors";
import { runIdempotentManageWrite } from "@/lib/manage/idempotency";
import { type ManageEndpointId } from "@/lib/manage/permissions";
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

/**
 * 业务拒绝码 → 对外信封错误的映射表（M20.3 起每个服务域自带一张）。
 * 键是 Service 层 `prepare/lock/execute` 拒绝时的 `code` 字符串；未登记的码一律 internal，
 * 不透出服务文本。新写端点接入时由其服务模块提供自己的表，经 `commitWrite` 传入。
 */
export type DenialHttpMap = Readonly<Record<string, ManageErrorCode>>;

/**
 * 内容治理域的共享码表（M20.2 语义原样外移）：
 * 资源权限与不存在同型（越权不泄露 → not_found）；状态与版本冲突 → 409；理由类 → 400。
 */
export const MODERATION_DENIAL_HTTP: DenialHttpMap = {
  not_found: "not_found",
  forbidden: "not_found",
  bad_state: "state_conflict",
  conflict: "state_conflict",
  bad_reason: "bad_request",
  reason_required: "bad_request",
  reason_too_long: "bad_request",
};

/** 按域码表把业务拒绝转统一信封；未登记的码由入口兜底为 internal。 */
function requireSuccess<T extends { ok: true }>(
  result: T | WriteDenial,
  denialHttp: DenialHttpMap,
): T {
  if (result.ok) return result;
  const envelope = denialHttp[result.code];
  throw new ManageApiError(envelope ?? "internal");
}

function auditContext(ctx: ManageHandlerContext) {
  const actor: ConfigActor = { userId: ctx.token.userId, ip: ctx.ip, via: "api" };
  return { actor, trace: { requestId: ctx.requestId, tokenSuffix: ctx.token.suffix } };
}

async function commitWrite(
  ctx: ManageHandlerContext,
  endpoint: ManageEndpointId,
  params: WriteInput<Record<string, unknown>>,
  preparation: Promise<PreparedWrite | WriteDenial>,
  /** 写域的拒绝码表；缺省为内容治理域（现有两端点的语义不变）。 */
  denialHttp: DenialHttpMap = MODERATION_DENIAL_HTTP,
): Promise<unknown> {
  const operation = requireSuccess(await preparation, denialHttp);
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
      const locked = requireSuccess(await operation.lock(tx), denialHttp);
      return async () => requireSuccess(await locked.execute(), denialHttp);
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
