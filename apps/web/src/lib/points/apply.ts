import { and, eq, sql } from "drizzle-orm";
import { getWebDb, insertIdOf, pointAccounts, pointLedger } from "@funwind/db";
import type { DbTx } from "@/lib/audit";
import { emit } from "@/modules/kernel/bus";
import { BUILTIN_POINT_CHANNELS } from "@/modules/kernel/builtin";
import type { EventPayloads, PointChannelDef } from "@/modules/kernel/types";
import {
  IdempotencyConflictError,
  InsufficientPointsError,
  InvalidDeltaError,
  PointsOverflowError,
  UnregisteredChannelError,
} from "./errors";
import { lockAccount } from "./account";
import { resolvePointChannel } from "./channels";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "./retry";

/**
 * 积分变动的**唯一入口**（硬约定 3c，docs/POINTS.md §2）。
 * 台账只增不改不删，余额快照 = 台账之和；任何人不得绕过此函数写 point_ledger / point_accounts
 * （守卫测试 no-direct-points-write.test.ts 机制性保证）。
 *
 * 并发语义：先锁账户行（SELECT … FOR UPDATE），锁内做幂等判定、余额判定与记账。
 * 同一幂等键重放返回既有结果、不重复记账；余额永不为负（在行锁内检查，不依赖 unsigned 报错）。
 *
 * 使用内核的入口（Server Action / Route Handler）须自行 import "@/modules"，否则模块声明的渠道不可见（失败即封闭）。
 */

export interface ApplyPointsRequest {
  userId: number;
  channel: string;
  /** 非零整数；earn.* 为正、spend.* 为负、adjust.* 与 opening 按渠道方向校验 */
  delta: number;
  /** 幂等键：同一业务动作必须稳定（如 gate_unlock:{gateId}:{userId}），全站唯一 */
  idempotencyKey: string;
  /** 关联对象，便于对账追溯 */
  ref?: { type: string; id: number };
  note?: string;
}

export interface ApplyPointsResult {
  /** false = 幂等重放，没有新记账 */
  applied: boolean;
  ledgerId: number;
  balanceAfter: number;
  /** 本次新记账产生的事件；重放为 null。嵌入事务时由最外层调用者在提交后派发 */
  event: EventPayloads["points.changed"] | null;
}

export interface ApplyDeps {
  /** 覆盖启用模块集合（单测注入） */
  enabledModuleIds?: ReadonlySet<string>;
  /** 覆盖事件派发（单测注入；缺省走内核总线） */
  emitter?: (name: "points.changed", payload: EventPayloads["points.changed"]) => Promise<unknown>;
}

const defaultEmitter: NonNullable<ApplyDeps["emitter"]> = (name, payload) =>
  emit(name, payload, { source: "points" });

/** 内置渠道（同步、不查库）：unlockGate 等核心流程在开事务前取用 */
export function builtinChannel(key: string): PointChannelDef {
  const c = BUILTIN_POINT_CHANNELS.find((x) => x.key === key);
  if (!c) throw new UnregisteredChannelError(key);
  return c;
}

/** 渠道与金额的纯校验（符号须与渠道方向一致）；不碰数据库 */
/** point_ledger.delta 是 INT；point_accounts.balance 是 INT UNSIGNED。越界时 MySQL 报 1264，用户只会看到 500 */
export const MAX_DELTA = 2_147_483_647;
export const MAX_BALANCE = 4_294_967_295;

export function validateRequest(channel: PointChannelDef, req: ApplyPointsRequest): void {
  if (!Number.isInteger(req.delta) || req.delta === 0) {
    throw new InvalidDeltaError(`delta 必须是非零整数: ${req.delta}`);
  }
  if (Math.abs(req.delta) > MAX_DELTA) {
    throw new InvalidDeltaError(`delta 超出单笔上限 ±${MAX_DELTA}: ${req.delta}`);
  }
  if (channel.direction === "earn" && req.delta < 0) {
    throw new InvalidDeltaError(`收入渠道 ${req.channel} 的 delta 必须为正`);
  }
  if (channel.direction === "spend" && req.delta > 0) {
    throw new InvalidDeltaError(`支出渠道 ${req.channel} 的 delta 必须为负`);
  }
  if (!req.idempotencyKey || req.idempotencyKey.length > 96) {
    throw new InvalidDeltaError("幂等键必须为 1–96 个字符");
  }
}

/** 解析渠道（未注册/所属模块停用则抛错）。**必须在开事务之前调用**：它可能读 module_state，事务内再借连接会造成连接池饥饿 */
export async function resolveChannelOrThrow(
  key: string,
  enabledModuleIds?: ReadonlySet<string>,
): Promise<PointChannelDef> {
  const channel = await resolvePointChannel(key, enabledModuleIds);
  if (!channel) throw new UnregisteredChannelError(key);
  return channel;
}

/**
 * 在调用方已开启的事务内记账（unlockGate 等多步原子操作用）。不提交、不派发事件。
 * 调用方的事务必须以 POINTS_TX_OPTIONS（READ COMMITTED）开启，否则新账户并发首次入账会因间隙锁死锁（见 retry.ts）。
 * 渠道须由调用方在事务外解析好传入（resolveChannelOrThrow / builtinChannel），事务内不再借用第二条连接。
 */
export async function applyPointsInTx(
  tx: DbTx,
  req: ApplyPointsRequest,
  channel: PointChannelDef,
): Promise<ApplyPointsResult> {
  validateRequest(channel, req);

  // 锁账户行（不存在则先建立）；之后的一切判定都在锁内进行
  const balance = await lockAccount(tx, req.userId);

  // 幂等：用 FOR UPDATE 读（当前读），避免调用方事务较早建立的快照看不到别人刚提交的记账
  const [existing] = await tx
    .select()
    .from(pointLedger)
    .where(eq(pointLedger.idempotencyKey, req.idempotencyKey))
    .for("update");
  if (existing) {
    if (
      existing.userId !== req.userId ||
      existing.channel !== req.channel ||
      existing.delta !== req.delta
    ) {
      throw new IdempotencyConflictError(req.idempotencyKey);
    }
    return {
      applied: false,
      ledgerId: existing.id,
      balanceAfter: existing.balanceAfter,
      event: null,
    };
  }

  const balanceAfter = balance + req.delta;
  if (balanceAfter < 0) throw new InsufficientPointsError(req.userId, balance, -req.delta);
  if (balanceAfter > MAX_BALANCE) throw new PointsOverflowError(req.userId, balance, req.delta);

  const ledgerId = insertIdOf(
    await tx.insert(pointLedger).values({
      userId: req.userId,
      delta: req.delta,
      balanceAfter,
      channel: req.channel,
      refType: req.ref?.type ?? null,
      refId: req.ref?.id ?? null,
      idempotencyKey: req.idempotencyKey,
      note: req.note ?? "",
      createdAt: sql`NOW()`,
    }),
  );

  await tx
    .update(pointAccounts)
    .set({
      balance: balanceAfter,
      lifetimeEarned: sql`${pointAccounts.lifetimeEarned} + ${Math.max(req.delta, 0)}`,
      lifetimeSpent: sql`${pointAccounts.lifetimeSpent} + ${Math.max(-req.delta, 0)}`,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(pointAccounts.userId, req.userId)));

  return {
    applied: true,
    ledgerId,
    balanceAfter,
    event: { userId: req.userId, channel: req.channel, delta: req.delta },
  };
}

/** 独立记账：自己开事务（死锁自动重试），提交后派发 points.changed。事件派发失败不影响记账结果 */
export async function applyPoints(
  req: ApplyPointsRequest,
  deps: ApplyDeps = {},
): Promise<ApplyPointsResult> {
  // 渠道解析与参数校验都在开事务之前：失败的请求不占事务，也不会在事务内再借连接
  const channel = await resolveChannelOrThrow(req.channel, deps.enabledModuleIds);
  validateRequest(channel, req);
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction((tx) => applyPointsInTx(tx, req, channel), POINTS_TX_OPTIONS),
  );
  if (result.event) {
    try {
      await (deps.emitter ?? defaultEmitter)("points.changed", result.event);
    } catch (e) {
      console.error("[points] points.changed 派发失败（记账已提交）:", e);
    }
  }
  return result;
}
