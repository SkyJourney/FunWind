import "server-only";

import { z } from "zod";
import { APPEALS_DENIAL_HTTP, prepareApiAppealResolve } from "@/lib/authz/appeals";
import {
  prepareApiRestriction,
  prepareApiRestrictionLift,
  prepareApiSessionRevoke,
  RESTRICTIONS_DENIAL_HTTP,
} from "@/lib/authz/restrictions-admin";
import { isValidBeijingDateTime } from "@/lib/datetime";
import { commitWrite, type DenialHttpMap } from "@/lib/manage/content-writes";
import type { ManageEndpointId } from "@/lib/manage/permissions";
import type { ManageHandlerContext } from "@/lib/manage/route";

/** 用户治理域合并码表：限制/会话吊销 + 申诉处置（未登记码由入口兜底 internal）。 */
export const USER_WRITES_DENIAL_HTTP: DenialHttpMap = {
  ...RESTRICTIONS_DENIAL_HTTP,
  ...APPEALS_DENIAL_HTTP,
};

/** API 操作者恒为令牌持有人；审计 trace 携带 requestId 与令牌尾号。 */
function apiAudit(ctx: ManageHandlerContext) {
  return {
    admin: { userId: ctx.token.userId, ip: ctx.ip, via: "api" as const },
    trace: { requestId: ctx.requestId, tokenSuffix: ctx.token.suffix },
  };
}

/** 创建限制路由的请求体：kind×scopeId 配对、endsAt 未来性与目标存在性由服务层复核。 */
export const manageRestrictionInput = z.strictObject({
  kind: z.enum(["ban", "forum_ban", "mute", "no_avatar", "no_signature"]),
  reason: z.string().trim().min(1).max(255),
  endsAt: z.string().refine(isValidBeijingDateTime).nullable(),
  scopeId: z.number().int().min(0).default(0),
});

/** 解除限制路由的请求体：解除说明必填（写入审计，回传被限制人）。 */
export const manageRestrictionLiftInput = z.strictObject({
  note: z.string().trim().min(1).max(255),
});

/** 吊销会话路由的请求体保持空对象：sessionId 在路径中，由路由注入参与幂等指纹。 */
export const manageSessionRevokeInput = z.strictObject({});

/** 申诉处置路由的请求体：status + 结果说明（送达申诉人，1–1000 字）。 */
export const manageAppealResolveInput = z.strictObject({
  status: z.enum(["approved", "rejected"]),
  result: z.string().trim().min(1).max(1000),
});

type WriteInput<T> = { targetId: number; idempotencyKey: string; input: T };

/** 创建限制（五类）：targetId 即目标用户 uid，注入服务层入参。 */
export function restrictManageUser(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageRestrictionInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "users.restrict",
    params,
    prepareApiRestriction(admin, { userId: params.targetId, ...params.input }, trace),
    USER_WRITES_DENIAL_HTTP,
  );
}

/** 解除限制：uid 为路径语义的归属校验（越权与不存在同型 404），targetId 为限制行 id。 */
export function liftManageRestriction(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageRestrictionLiftInput>> & { uid: number },
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "users.lift",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: params.input },
    prepareApiRestrictionLift(admin, params.uid, params.targetId, params.input.note, trace),
    USER_WRITES_DENIAL_HTTP,
  );
}

/** 吊销会话：sessionId 由路由注入参与幂等指纹（请求体为空对象），targetId 为目标用户 uid。 */
export function revokeManageUserSession(
  ctx: ManageHandlerContext,
  params: {
    targetId: number;
    idempotencyKey: string;
    input: { sessionId: string };
  },
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "users.revoke-session",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: params.input },
    prepareApiSessionRevoke(admin, params.targetId, params.input.sessionId, trace),
    USER_WRITES_DENIAL_HTTP,
  );
}

/** 申诉处置：uid 为路径语义的归属校验，targetId 为申诉 id。 */
export function resolveManageUserAppeal(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageAppealResolveInput>> & { uid: number },
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "users.resolve-appeal",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: params.input },
    prepareApiAppealResolve(
      admin,
      params.uid,
      params.targetId,
      params.input.status,
      params.input.result,
      trace,
    ),
    USER_WRITES_DENIAL_HTTP,
  );
}

/** 管理端点 id 的本域字面量（供路由断言端点 id 拼写）。 */
export type UserWriteEndpointId = Extract<
  ManageEndpointId,
  "users.restrict" | "users.lift" | "users.revoke-session" | "users.resolve-appeal"
>;
