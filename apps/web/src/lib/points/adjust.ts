import "server-only";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getWebDb, pointAccounts, users } from "@funwind/db";
import type { ConfigActor, DbTx } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";
import type { PointChannelDef } from "@/modules/kernel/types";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";
import { MAX_DELTA, applyPointsInTx, resolveChannelOrThrow, type ApplyPointsResult } from "./apply";
import {
  InsufficientPointsError,
  InvalidDeltaError,
  PointsOverflowError,
  UnregisteredChannelError,
} from "./errors";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "./retry";

/**
 * 管理员手工调整（M7，docs/POINTS.md §4 `adjust.admin`）：强制备注、出审计。
 * 台账写入与 audit_log 在**同一事务**（与 authz/admin.ts 同纪律：不存在「改了余额却没留痕」的窗口）；
 * 事务以 POINTS_TX_OPTIONS（READ COMMITTED）开启（M7-2 口径），提交后派发 `points.changed`。
 *
 * 幂等键：每次调整一个随机 UUID——手工调整没有「同一业务动作重放」的语义，重放反而危险
 * （管理员点两次就是两笔）。防重由 UI 提交与频控负责。
 */

export interface AdjustRequest {
  /** 被调整的用户 */
  userId: number;
  /** 非零整数：正为增加、负为扣减 */
  delta: number;
  /** 强制备注（入台账 note 与审计 after_json） */
  note: string;
}

/** 手工调整的域拒绝码（M20.3 Step 4）：后台包装转异常（文案由 denial.message 承载）。 */
export type AdjustDenialCode =
  | "bad_delta"
  | "note_required"
  | "channel_unavailable"
  | "not_found"
  | "insufficient_points"
  | "points_overflow";
type AdjustDenial = ModerationWriteDenial<AdjustDenialCode>;

/** 校验后的调整计划：delta/note 已核验，进入渠道解析与锁段。 */
type AdjustPlan = { userId: number; delta: number; note: string };

/** 输入校验（后台与 REST 共享，事务外）：非零整数（含单笔上限）+ 备注必填。 */
function planAdjust(req: AdjustRequest): { ok: true; plan: AdjustPlan } | AdjustDenial {
  if (!Number.isInteger(req.delta) || req.delta === 0) {
    return { ok: false, code: "bad_delta", message: `调整额度必须是非零整数: ${req.delta}` };
  }
  if (Math.abs(req.delta) > MAX_DELTA) {
    return {
      ok: false,
      code: "bad_delta",
      message: `delta 超出单笔上限 ±${MAX_DELTA}: ${req.delta}`,
    };
  }
  const note = req.note.trim();
  if (!note) return { ok: false, code: "note_required", message: "必须填写调整备注" };
  return { ok: true, plan: { userId: req.userId, delta: req.delta, note } };
}

/** 渠道解析（后台与 REST 共享，**必须在开事务之前**：它可能读 module_state，事务内再借连接会造成连接池饥饿）。 */
async function resolveAdjustChannel(): Promise<
  { ok: true; channel: PointChannelDef } | AdjustDenial
> {
  try {
    return { ok: true, channel: await resolveChannelOrThrow("adjust.admin") };
  } catch (e) {
    if (e instanceof UnregisteredChannelError) {
      return { ok: false, code: "channel_unavailable", message: e.message };
    }
    throw e;
  }
}

/** 锁段（REST 变体）：目标用户行 FOR UPDATE（不存在 → not_found）；accounts 行存在则一并锁定。
 * 首次调整（无账户行）不拒——execute 的 lockAccount 沿用后台「不存在则先建立」语义，两端一致。 */
async function lockAdjustTarget(tx: DbTx, userId: number): Promise<{ ok: true } | AdjustDenial> {
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for("update");
  if (!user) return { ok: false, code: "not_found", message: "目标用户不存在" };
  await tx
    .select({ userId: pointAccounts.userId })
    .from(pointAccounts)
    .where(eq(pointAccounts.userId, userId))
    .for("update");
  return { ok: true };
}

/** 执行段（后台与 REST 共享）：applyPointsInTx + 审计（trace 仅 REST 传入时附加）+ 事件入队（同事务）。
 * 幂等键保持 `adjust:{randomUUID}` 的后台语义（故意不可重放）；PointsError 向上穿透——
 * 后台保持异常形态，REST 变体在 execute 就地转 denial。 */
async function applyAdjustInTx(
  tx: DbTx,
  admin: ConfigActor & { userId: number },
  plan: AdjustPlan,
  channel: PointChannelDef,
  trace?: ModerationApiTrace,
): Promise<{ res: ApplyPointsResult; event: EnqueuedEvent | null }> {
  const res = await applyPointsInTx(
    tx,
    {
      userId: plan.userId,
      channel: "adjust.admin",
      delta: plan.delta,
      idempotencyKey: `adjust:${randomUUID()}`,
      ref: { type: "admin", id: admin.userId },
      note: plan.note,
    },
    channel,
  );
  await writeAudit(tx, {
    actorId: admin.userId,
    action: "points.adjust",
    targetType: "user",
    targetId: plan.userId,
    before: { balance: res.balanceAfter - plan.delta },
    after: {
      balance: res.balanceAfter,
      delta: plan.delta,
      note: plan.note,
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
  // points.adjusted 通知的消费源（M8）：经 outbox，调整已提交则通知事件必在
  const event = res.event
    ? await enqueueEventInTx(tx, "points.changed", res.event, {
        actorId: admin.userId,
        source: "points",
      })
    : null;
  return { res, event };
}

export async function adjustPointsByAdmin(
  admin: ConfigActor & { userId: number },
  req: AdjustRequest,
): Promise<ApplyPointsResult> {
  const planned = planAdjust(req);
  if (!planned.ok) throw new InvalidDeltaError(planned.message ?? "调整被拒绝");
  const channeled = await resolveAdjustChannel();
  if (!channeled.ok) throw new UnregisteredChannelError("adjust.admin");

  let enqueued: EnqueuedEvent[] = [];
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      // 每次尝试都从空开始（与 posting 同纪律）
      enqueued = [];
      const applied = await applyAdjustInTx(tx, admin, planned.plan, channeled.channel);
      if (applied.event) enqueued.push(applied.event);
      return applied.res;
    }, POINTS_TX_OPTIONS),
  );

  await dispatchOutboxRows(enqueued);
  await sweepPending();
  return result;
}

// ============================================================
// REST 写变体（M20.3 Step 4）：prepare/lock/execute 三段式，供管理 REST 幂等
// 管线接入；与后台入口共享 plan/resolve/apply 内核，记账/审计/事件语义完全一致。
// 幂等契约：prepare（事务外）做校验与渠道解析；lock 段只做存在性锁；execute
// 在幂等管线的外层事务内记账+审计+事件（闭包捕获 lock 的 tx，不另开事务）。
// 内部幂等键保持 `adjust:{uuid}` 不变——REST 的幂等重放由管理幂等管线缓存承担。
// ============================================================

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const POINTS_DENIAL_HTTP = {
  bad_delta: "bad_request",
  note_required: "bad_request",
  channel_unavailable: "state_conflict",
  not_found: "not_found",
  insufficient_points: "state_conflict",
  points_overflow: "state_conflict",
} as const;

/** REST 三段式写变体的准备产物类型（data 为写响应载荷，denial 复用域拒绝码）。 */
export type PreparedApiPointsAdjust = PreparedModerationWrite<
  { userId: number; delta: number; balanceAfter: number },
  AdjustDenialCode
>;

/** REST 手工调整：校验/渠道解析在 prepare（事务外），存在性在锁段，记账/审计/事件在 execute。 */
export async function prepareApiPointsAdjust(
  admin: ConfigActor & { userId: number },
  req: AdjustRequest,
  trace?: ModerationApiTrace,
): Promise<PreparedApiPointsAdjust | AdjustDenial> {
  const planned = planAdjust(req);
  if (!planned.ok) return planned;
  const channeled = await resolveAdjustChannel();
  if (!channeled.ok) return channeled;
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockAdjustTarget(tx, planned.plan.userId);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          try {
            const applied = await applyAdjustInTx(
              tx,
              admin,
              planned.plan,
              channeled.channel,
              trace,
            );
            return {
              ok: true as const,
              data: {
                userId: planned.plan.userId,
                delta: planned.plan.delta,
                balanceAfter: applied.res.balanceAfter,
              },
              async afterCommit() {
                if (applied.event) await dispatchOutboxRows([applied.event]);
                await sweepPending();
              },
            };
          } catch (e) {
            // 可预期拒绝（余额/上限由账户当前状态裁决，归执行段）转 denial；其余异常照抛
            if (e instanceof InsufficientPointsError) {
              return {
                ok: false as const,
                code: "insufficient_points" as const,
                message: e.message,
              };
            }
            if (e instanceof PointsOverflowError) {
              return { ok: false as const, code: "points_overflow" as const, message: e.message };
            }
            throw e;
          }
        },
      };
    },
  };
}
