import type { EventName, EventPayloads } from "./types.js";
import { getEnabledModuleIds } from "./state.js";
import { getEventConsumers } from "./registry.js";

/**
 * 事件总线：同步顺序派发、逐消费者隔离、event_log 审计落库。
 * 约束（docs/MODULES.md）：
 *  - 单事件内按模块注册序派发；跨模块全局顺序不做
 *  - 消费者抛错只记录，不阻塞后续消费者，更不反噬业务主流程
 *  - 审计落库失败仅打日志（审计降级 ≠ 业务失败）
 */

export interface EventLogRow {
  eventName: string;
  payload: unknown;
  actorId: number | null;
  source: string | null;
  errorJson: string | null;
  createdAt: Date;
}

export type EventLogWriter = (row: EventLogRow) => Promise<void>;

export interface EmitDeps {
  /** 覆盖启用模块集合（单测注入；缺省读 module_state） */
  enabledModuleIds?: ReadonlySet<string>;
  /** 覆盖审计落库（单测注入 fake；缺省写 event_log 表） */
  writer?: EventLogWriter;
  now?: Date;
  source?: string;
  actorId?: number;
}

export interface EmitResult {
  dispatched: { moduleId: string }[];
  errors: { moduleId: string; message: string }[];
  logged: boolean;
}

async function defaultWriter(row: EventLogRow): Promise<void> {
  const [{ eventLog }, { withDb }] = await Promise.all([
    import("@funwind/db"),
    import("@funwind/db"),
  ]);
  await withDb(async ({ db }) => {
    await db.insert(eventLog).values({
      eventName: row.eventName,
      payload: row.payload as object,
      actorId: row.actorId,
      source: row.source,
      errorJson: row.errorJson,
      createdAt: row.createdAt,
    });
  });
}

export async function emit<K extends EventName>(
  name: K,
  payload: EventPayloads[K],
  deps: EmitDeps = {},
): Promise<EmitResult> {
  const now = deps.now ?? new Date();
  const enabled = deps.enabledModuleIds ?? (await getEnabledModuleIds());
  const writer = deps.writer ?? defaultWriter;

  const consumers = getEventConsumers(name).filter((c) => enabled.has(c.moduleId));

  const dispatched: { moduleId: string }[] = [];
  const errors: { moduleId: string; message: string }[] = [];

  for (const { moduleId, consume } of consumers) {
    try {
      await consume(payload);
      dispatched.push({ moduleId });
    } catch (e) {
      errors.push({ moduleId, message: e instanceof Error ? e.message : String(e) });
    }
  }

  let logged = true;
  try {
    await writer({
      eventName: name,
      payload,
      actorId: deps.actorId ?? ("userId" in payload ? (payload.userId as number) : null),
      source: deps.source ?? null,
      errorJson: errors.length > 0 ? JSON.stringify(errors) : null,
      createdAt: now,
    });
  } catch (e) {
    logged = false;
    console.error(`[kernel] event_log 落库失败（审计降级）: ${name}`, e);
  }

  return { dispatched, errors, logged };
}
