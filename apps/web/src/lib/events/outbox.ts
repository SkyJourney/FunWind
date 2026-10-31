import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { eventOutbox, getWebDb, insertIdOf } from "@funwind/db";
import { nowBeijingWallTime } from "@/lib/datetime";
import type { DbExecutor } from "@/lib/audit";
import { emit } from "@/modules/kernel/bus";
import { isEventName, validateEventPayload } from "@/modules/kernel/event-names";
import type { EventName, EventPayloads } from "@/modules/kernel/types";

/**
 * 事务性 outbox（M7 拍板，docs/MODULES.md §8）：业务事务内 enqueue，提交后同步派发为快路径，
 * 崩溃或**消费失败**留下的 pending 行由 drain 补派。语义是 **at-least-once**：
 *  · 快路径「派发成功→标记」之间崩溃 → 重放；
 *  · 消费者抛错（emit 只把错误记进 EmitResult.errors / event_log.errorJson，不抛出）→ 行保持 pending 补派；
 *  · 并发 drain / 重放不互斥，同一事件可能派发多次——消费端以既有幂等键吸收（台账 idempotency_key 等）；
 *  · 重复失败的行按 dispatch_error.attempts 退避（首次失败立即重试），持续失败由 db:verify 滞留检查报警；
 *  · 重放与重复派发照常写 event_log，source="outbox" 可与首次派发区分。
 * 覆盖范围（M7）：posting 事件族（thread.created / thread.replied / content.submitted / attachment.uploaded，
 * 发主题 / 回帖 / 编辑三处）——gate / message 等其余事件的可靠派发仍归 M8-1。
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
  const id = insertIdOf(
    await tx.insert(eventOutbox).values({
      eventName: name,
      payload: payload as object,
      actorId: opts.actorId ?? null,
      source: opts.source ?? null,
      createdAt: nowBeijingWallTime(),
    }),
  );
  return {
    id,
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
      const result = await emitFn(row.name, row.payload as never);
      // 内核 emit 吞掉消费者异常（只进 EmitResult.errors 与 event_log.errorJson）——
      // 那也是「消费失败」：行保持 pending 等补派，而不是标记完成（否则奖励静默丢失）
      if (hasConsumerErrors(result)) {
        await recordDispatchError(row.id, new Error(describeConsumerErrors(result)));
        continue;
      }
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

/**
 * 内核 emit 的返回值里带消费者错误数组（EmitResult.errors）；注入的 emitter 不返回该形状。
 * 有消费者错误 = 本次消费没有完成 = 不能标记已派发。
 */
function hasConsumerErrors(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { errors?: unknown }).errors) &&
    (result as { errors: unknown[] }).errors.length > 0
  );
}

function describeConsumerErrors(result: unknown): string {
  const errors = (result as { errors: { moduleId: string; message: string }[] }).errors;
  return `消费者失败: ${errors.map((e) => `${e.moduleId}: ${e.message}`).join("; ")}`;
}

async function recordDispatchError(id: number, e: unknown): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[outbox] #${id} 派发失败（保持 pending，等待补派）: ${message}`);
  try {
    // 累计尝试次数：退避只针对「重复失败」的行（首次失败立即补派，瞬态故障不被延迟）
    const [prev] = await getWebDb()
      .select({ err: eventOutbox.dispatchError })
      .from(eventOutbox)
      .where(eq(eventOutbox.id, id))
      .limit(1);
    const prevErr = (prev?.err ?? null) as { attempts?: number } | null;
    await getWebDb()
      .update(eventOutbox)
      .set({
        dispatchError: {
          message,
          at: nowBeijingWallTime(),
          attempts: (typeof prevErr?.attempts === "number" ? prevErr.attempts : 0) + 1,
        },
      })
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
  // 毒行退避：**重复失败**（attempts ≥ 2）且最近 10 分钟内失败过的行本轮跳过——
  // 否则 id ASC 的批首会被持续失败的行永久占住，更新的合法行饿死。
  // 首次失败不退避：瞬态故障（连接抖动等）应当被下一次巡检立即重试。
  const pending = await getWebDb()
    .select({
      id: eventOutbox.id,
      eventName: eventOutbox.eventName,
      payload: eventOutbox.payload,
      actorId: eventOutbox.actorId,
      source: eventOutbox.source,
    })
    .from(eventOutbox)
    .where(
      and(
        isNull(eventOutbox.dispatchedAt),
        sql`(dispatch_error IS NULL
             OR JSON_EXTRACT(dispatch_error, '$.attempts') < 2
             OR CAST(JSON_UNQUOTE(JSON_EXTRACT(dispatch_error, '$.at')) AS DATETIME) < NOW() - INTERVAL 10 MINUTE)`,
      ),
    )
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
      let result: unknown;
      if (deps.emitter) {
        result = await deps.emitter(name, row.payload as never);
      } else {
        result = await emit(name, row.payload as never, {
          source: "outbox",
          actorId: row.actorId ?? undefined,
        });
      }
      if (hasConsumerErrors(result)) {
        await recordDispatchError(row.id, new Error(describeConsumerErrors(result)));
        failed++;
        continue;
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
