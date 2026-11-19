import "server-only";

import { z } from "zod";
import type { ConfigActor, DbTx } from "@/lib/audit";
import { ManageApiError } from "@/lib/manage/errors";
import { runIdempotentManageWrite } from "@/lib/manage/idempotency";
import type { ManageEndpointId } from "@/lib/manage/permissions";
import type { ManageHandlerContext } from "@/lib/manage/route";
import type { ModerationWriteDenial, PreparedModerationWrite } from "@/lib/moderation/contents";
import {
  prepareApiReportHandle,
  REPORTS_DENIAL_HTTP,
  type ApiReportHandleCode,
  type ApiReportHandleData,
} from "@/lib/reports/service";

/** 举报处置路由的请求体：decision 由路径隐含（resolve/dismiss），note 为回给举报人的反馈。 */
export const manageReportHandleInput = z.strictObject({
  note: z.string().trim().min(1).max(255),
});

type PreparedReport = PreparedModerationWrite<ApiReportHandleData, ApiReportHandleCode>;
type ReportDenial = ModerationWriteDenial<ApiReportHandleCode>;
type ReportLockOk = {
  ok: true;
  execute(): Promise<
    { ok: true; data: ApiReportHandleData; afterCommit?: () => Promise<void> } | ReportDenial
  >;
};

/** 举报域拒绝码 → 信封：不存在/非 pending/说明问题（与服务层 REPORTS_DENIAL_HTTP 同源）。 */
function denialEnvelope(code: ApiReportHandleCode): never {
  const envelope = (REPORTS_DENIAL_HTTP as Record<string, ManageApiError["code"] | undefined>)[
    code
  ];
  throw new ManageApiError(envelope ?? "internal");
}

/** prepare 结果：拒绝即抛信封（缺省 internal），成功原样返回。 */
function requirePrepared(result: PreparedReport | ReportDenial): PreparedReport {
  if (result.ok) return result;
  denialEnvelope(result.code);
}

/** lock 结果：拒绝即抛信封，成功返回可执行的锁定产物。 */
function requireLockOk(result: ReportLockOk | ReportDenial): ReportLockOk {
  if (result.ok) return result;
  denialEnvelope(result.code);
}

/** execute 结果：拒绝即抛信封，成功返回写响应数据。 */
function requireExecuted(
  result: { ok: true; data: ApiReportHandleData; afterCommit?: () => Promise<void> } | ReportDenial,
): { ok: true; data: ApiReportHandleData; afterCommit?: () => Promise<void> } {
  if (result.ok) return result;
  denialEnvelope(result.code);
}

/** 举报写端点的幂等事务封装：prepare（状态校验）→ lock（行锁复验）→ execute（处置+审计+通知）。 */
async function commitReportWrite(
  ctx: ManageHandlerContext,
  endpoint: Extract<ManageEndpointId, "reports.resolve" | "reports.dismiss">,
  targetId: number,
  idempotencyKey: string,
  input: Record<string, unknown>,
  decision: "resolved" | "dismissed",
): Promise<unknown> {
  const actor: ConfigActor = { userId: ctx.token.userId, ip: ctx.ip, via: "api" };
  const trace = { requestId: ctx.requestId, tokenSuffix: ctx.token.suffix };
  const operation = requirePrepared(
    await prepareApiReportHandle(
      actor,
      targetId,
      { decision, note: String(input.note ?? "") },
      trace,
    ),
  );
  return runIdempotentManageWrite(
    {
      tokenId: ctx.token.id,
      endpoint,
      idempotencyKey,
      requestId: ctx.requestId,
    },
    targetId,
    input,
    async (tx: DbTx) => {
      const locked = requireLockOk(await operation.lock(tx));
      return async () => requireExecuted(await locked.execute());
    },
  );
}

export function resolveManageReport(
  ctx: ManageHandlerContext,
  params: {
    targetId: number;
    idempotencyKey: string;
    input: z.infer<typeof manageReportHandleInput>;
  },
): Promise<unknown> {
  return commitReportWrite(
    ctx,
    "reports.resolve",
    params.targetId,
    params.idempotencyKey,
    params.input,
    "resolved",
  );
}

export function dismissManageReport(
  ctx: ManageHandlerContext,
  params: {
    targetId: number;
    idempotencyKey: string;
    input: z.infer<typeof manageReportHandleInput>;
  },
): Promise<unknown> {
  return commitReportWrite(
    ctx,
    "reports.dismiss",
    params.targetId,
    params.idempotencyKey,
    params.input,
    "dismissed",
  );
}
