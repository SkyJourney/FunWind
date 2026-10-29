import type { EventName, EventPayloads } from "./types";
import { getWebDb, eventLog } from "@funwind/db";
import { nowBeijingWallTime } from "@/lib/datetime";
import { getEnabledModuleIds } from "./state";
import { getEventConsumers } from "./registry";

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
  createdAt: string; // 北京墙面 DATETIME（库内语义，见 lib/datetime）
}

export type EventLogWriter = (row: EventLogRow) => Promise<void>;

export interface EmitDeps {
  /** 覆盖启用模块集合（单测注入；缺省读 module_state） */
  enabledModuleIds?: ReadonlySet<string>;
  /** 覆盖审计落库（单测注入 fake；缺省写 event_log 表） */
  writer?: EventLogWriter;
  now?: string; // 北京墙面 DATETIME 字符串
  source?: string;
  actorId?: number;
}

export interface EmitResult {
  dispatched: { moduleId: string }[];
  errors: { moduleId: string; message: string }[];
  logged: boolean;
}

/**
 * actor 语义映射（基线审查 P2-a）：每个事件的「动作发起者」字段。
 * deps.actorId 显式传入时优先（调用方比映射更清楚语义时使用，如被代操作）。
 */
const ACTOR_FIELD_BY_EVENT: Record<EventName, string | null> = {
  "user.logged_in": "userId",
  "user.registered": "userId",
  "user.followed": "userId",
  "thread.created": "authorId",
  "thread.replied": "authorId",
  "thread.edited": "editorId",
  "post.edited": "editorId",
  "thread.deleted": "operatorId",
  "post.deleted": "operatorId",
  "thread.moderated": "operatorId",
  "content.submitted": "authorId",
  "content.moderated": "operatorId",
  "post.mentioned": "authorId",
  "reaction.added": "userId",
  "poll.voted": "userId",
  "message.sent": "senderId",
  "attachment.uploaded": "uploaderId",
  "restriction.changed": "operatorId",
  "role.changed": "operatorId",
  "announcement.published": "createdBy",
  "points.changed": "userId",
  "gate.unlocked": "userId",
  "badge.awarded": "userId",
  "badge.revoked": "userId",
  "checkin.done": "userId",
};

function resolveActor(name: EventName, payload: EventPayloads[EventName]): number | null {
  const field = ACTOR_FIELD_BY_EVENT[name];
  if (!field) return null;
  const v = (payload as Record<string, unknown>)[field];
  return typeof v === "number" ? v : null;
}

async function defaultWriter(row: EventLogRow): Promise<void> {
  const db = getWebDb();
  await db.insert(eventLog).values({
    eventName: row.eventName,
    payload: row.payload as object,
    actorId: row.actorId,
    source: row.source,
    errorJson: row.errorJson,
    createdAt: row.createdAt,
  });
}

export async function emit<K extends EventName>(
  name: K,
  payload: EventPayloads[K],
  deps: EmitDeps = {},
): Promise<EmitResult> {
  const now = deps.now ?? nowBeijingWallTime();
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
      actorId: deps.actorId ?? resolveActor(name, payload),
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
