import { asc, eq, isNull, sql } from "drizzle-orm";
import { eventOutbox, getWebDb } from "@funwind/db";
import { nowBeijingWallTime } from "@/lib/datetime";
import type { DbExecutor } from "@/lib/audit";
import { emit } from "@/modules/kernel/bus";
import { isEventName, validateEventPayload } from "@/modules/kernel/event-names";
import type { EventName, EventPayloads } from "@/modules/kernel/types";

/**
 * 事务性 outbox（M7 拍板，docs/MODULES.md §outbox）：业务事务内 enqueue，提交后同步派发为快路径，
 * 崩溃留下的 pending 行由 drain 补派。语义是 **at-least-once**：
 *  · 快路径「派发成功→标记」之间崩溃 → 重放；
 *  · 并发 drain / 重放不互斥，同一事件可能派发多次——消费端以既有幂等键吸收
 *    （台账 idempotency_key、checkins / user_badges 联合主键）；
 *  · 重放与重复派发照常写 event_log，source="outbox" 可与首次派发区分。
 * 覆盖范围（M7）：posting 事件族（thread.created / thread.replied / content.submitted / attachment.uploaded）；
 * gate / message 等其余事件的可靠派发仍归 M8-1。
 */

export interface EnqueuedEvent {
  id: number;
  name: EventName;
  payload: EventPayloads[EventName];
  /** 业务来源（event_log 语义沿用 enqueue 时的声明，如 "posting"） */
  source: string | null;
  /** 动作发起者（透传给 emit 的 deps.actorId，优先于 payload 字段映射） */
  actorId: number | null;
}

/** 补派/派发的 emitter 形态（与内核 emit 同签名，测试可注入收集器） */
export type OutboxEmitter = <K extends EventName>(
  name: K,
  payload: EventPayloads[K],
) => Promise<unknown>;

/**
 * 业务事务内登记事件：与业务数据同事务提交/回滚——提交成功则事件必在 outbox（不丢），
 * 回滚则登记一并消失（不发不存在的事件）。登记时即校验事件名与必填载荷（编程错误在写入期暴露）。
 */
export async function enqueueEventInTx(
  tx: DbExecutor,
  name: EventName,
  payload: EventPayloads[EventName],
  opts: { actorId?: number; source?: string } = {},
): Promise<EnqueuedEvent> {
  if (!isEventName(name)) throw new Error(`[outbox] 未注册的事件名: ${String(name)}`);
  const invalid = validateEventPayload(name, payload);
  if (invalid) throw new Error(`[outbox] ${name} 载荷非法: ${invalid}`);
  const [row] = (await tx.insert(eventOutbox).values({
    eventName: name,
    payload: payload as object,
    actorId: opts.actorId ?? null,
    source: opts.source ?? null,
    createdAt: nowBeijingWallTime(),
  })) as unknown as [{ insertId: number }]; // insertId 只有 id 一列被用到；drizzle 的 mysql 返回形状收口与 points/apply.ts 同法
  return {
    id: Number(row.insertId),
    name,
    payload,
    source: opts.source ?? null,
    actorId: opts.actorId ?? null,
  };
}

/**
 * 快路径：提交后逐条派发并标记。派发失败（含消费方异常之外的派发本身失败）不反噬业务——
 * 行保持 pending（记录最近一次错误摘要），由 drain 补派；标记失败同样无害（行会被重放）。
 */
export async function dispatchOutboxRows(
  rows: readonly EnqueuedEvent[],
  deps: { emitter?: OutboxEmitter } = {},
): Promise<void> {
  for (const row of rows) {
    // 快路径沿用入队时声明的业务来源；deps.emitter 是测试/调用方注入
    const emitFn: OutboxEmitter =
      deps.emitter ??
      ((name, payload) =>
        emit(name, payload, {
          source: row.source ?? "outbox",
          actorId: row.actorId ?? undefined,
        }));
    try {
      await emitFn(row.name, row.payload as never);
    } catch (e) {
      await recordDispatchError(row.id, e);
      continue;
    }
    try {
      await getWebDb()
        .update(eventOutbox)
        .set({ dispatchedAt: sql`NOW()` })
        .where(eq(eventOutbox.id, row.id));
    } catch (e) {
      // 标记失败 → 行仍 pending → 事后重放；消费端幂等，记日志即可
      console.error(`[outbox] #${row.id} ${row.name} 已派发但标记失败（将重放）:`, e);
    }
  }
}

async function recordDispatchError(id: number, e: unknown): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[outbox] #${id} 派发失败（保持 pending，等待补派）: ${message}`);
  try {
    await getWebDb()
      .update(eventOutbox)
      .set({ dispatchError: { message, at: nowBeijingWallTime() } })
      .where(eq(eventOutbox.id, id));
  } catch (e2) {
    console.error(`[outbox] #${id} 派发错误摘要写入失败:`, e2);
  }
}

/** 单次巡检处理的行数上限：捎带巡检只求自愈不求清空，大批积压交给脚本 */
export const DRAIN_BATCH = 50;

export interface DrainSummary {
  /** 本次实际派发（含此前已派发但未标记的重放） */
  dispatched: number;
  failed: number;
  /** 巡检结束时仍 pending 的行数（含本次失败的） */
  pendingLeft: number;
}

/**
 * 补派巡检：按 id 升序取一批 pending 行派发。不加行锁、不互斥——并发巡检可能重复派发同一行，
 * 由消费端幂等吸收（见文件头）；这换来「巡检事务绝不久借连接」（与 applyPoints 同一纪律）。
 * 自愈入口：发帖/签到等业务在快路径之后捎带调用（见 sweepPending）；脚本与 verify 用全量批量版。
 */
export async function drainOutbox(
  deps: { emitter?: OutboxEmitter; limit?: number } = {},
): Promise<DrainSummary> {
  const limit = deps.limit ?? DRAIN_BATCH;
  const pending = await getWebDb()
    .select({
      id: eventOutbox.id,
      eventName: eventOutbox.eventName,
      payload: eventOutbox.payload,
      actorId: eventOutbox.actorId,
      source: eventOutbox.source,
    })
    .from(eventOutbox)
    .where(isNull(eventOutbox.dispatchedAt))
    .orderBy(asc(eventOutbox.id))
    .limit(limit);

  let dispatched = 0;
  let failed = 0;
  for (const row of pending) {
    const name = row.eventName;
    if (!isEventName(name)) {
      // 库里出现未知事件名：不可能是本文件写入的（enqueue 校验过），记错误并跳过，留给人工处理
      await recordDispatchError(row.id, new Error(`未知事件名 ${name}（疑似人工写入）`));
      failed++;
      continue;
    }
    try {
      // 补派：source="outbox" 标记重放；actorId 用入队时的动作发起者（payload 映射仅在缺省时兜底）。
      // 注入 emitter（测试/收集器）时不写 event_log，语义由注入方负责
      if (deps.emitter) {
        await deps.emitter(name, row.payload as never);
      } else {
        await emit(name, row.payload as never, {
          source: "outbox",
          actorId: row.actorId ?? undefined,
        });
      }
      dispatched++;
    } catch (e) {
      await recordDispatchError(row.id, e);
      failed++;
      continue;
    }
    try {
      await getWebDb()
        .update(eventOutbox)
        .set({ dispatchedAt: sql`NOW()` })
        .where(eq(eventOutbox.id, row.id));
    } catch (e) {
      console.error(`[outbox] #${row.id} 已补派但标记失败（将再次重放）:`, e);
    }
  }
  const [{ n }] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(eventOutbox)
    .where(isNull(eventOutbox.dispatchedAt));
  return { dispatched, failed, pendingLeft: Number(n) };
}

/**
 * 业务快路径之后的捎带自愈：每次发帖/签到顺手补一小批积压（有界、错误吞掉——
 * 自愈失败不影响本次业务）。没有 cron 依赖（M13 前不调度），流量本身就是巡检驱动。
 */
export async function sweepPending(deps: { emitter?: OutboxEmitter } = {}): Promise<void> {
  try {
    const { pendingLeft } = await drainOutbox({ emitter: deps.emitter, limit: 10 });
    if (pendingLeft > 0) {
      console.warn(`[outbox] 捎带巡检后仍有 ${pendingLeft} 行 pending（脚本可继续补派）`);
    }
  } catch (e) {
    console.error("[outbox] 捎带巡检失败（不影响业务）:", e);
  }
}

/** 仍 pending 的行数（db:verify 滞留检查用） */
export async function countPendingOutbox(): Promise<number> {
  const [row] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(eventOutbox)
    .where(isNull(eventOutbox.dispatchedAt));
  return Number(row?.n ?? 0);
}
