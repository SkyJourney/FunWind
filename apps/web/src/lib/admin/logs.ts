import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { auditLog, eventLog, getWebDb } from "@funwind/db";

/**
 * 审计中心查询（M9）：audit_log 与 event_log 统一筛选/分页；CSV 行生成是纯函数（单测锚定转义）。
 */

export interface LogFilter {
  action?: string;
  actorId?: number;
  /** ISO 日期下界（含） */
  since?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogRow {
  id: number;
  actorId: number | null;
  action: string;
  targetType: string;
  targetId: string;
  beforeJson: unknown;
  afterJson: unknown;
  ip: string | null;
  createdAt: string;
}

export async function queryAuditLogs(
  filter: LogFilter = {},
): Promise<{ items: AuditLogRow[]; total: number }> {
  const conds: SQL[] = [];
  if (filter.action) conds.push(eq(auditLog.action, filter.action));
  if (filter.actorId) conds.push(eq(auditLog.actorId, filter.actorId));
  if (filter.since) conds.push(gte(auditLog.createdAt, filter.since));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const [{ n }] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(auditLog)
    .where(where);
  const items = await getWebDb()
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.id))
    .limit(Math.min(filter.limit ?? 50, 200))
    .offset(filter.offset ?? 0);
  return { items: items as AuditLogRow[], total: Number(n) };
}

export interface EventLogRowView {
  id: number;
  eventName: string;
  actorId: number | null;
  source: string | null;
  errorJson: unknown;
  createdAt: string;
}

export async function queryEventLogs(
  filter: LogFilter = {},
): Promise<{ items: EventLogRowView[]; total: number }> {
  const conds: SQL[] = [];
  if (filter.action) conds.push(eq(eventLog.eventName, filter.action));
  if (filter.actorId) conds.push(eq(eventLog.actorId, filter.actorId));
  if (filter.since) conds.push(gte(eventLog.createdAt, filter.since));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const [{ n }] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(eventLog)
    .where(where);
  const items = await getWebDb()
    .select()
    .from(eventLog)
    .where(where)
    .orderBy(desc(eventLog.id))
    .limit(Math.min(filter.limit ?? 50, 200))
    .offset(filter.offset ?? 0);
  return { items: items as EventLogRowView[], total: Number(n) };
}

const CSV_HEADER = "id,created_at,action,actor_id,target_type,target_id,detail";

/** CSV 行生成（纯函数）：RFC 4180 转义（含逗号/引号/换行的字段用双引号包裹并双写内部引号） */
export function csvRows(
  rows: {
    id: number;
    createdAt: string;
    action: string;
    actorId: number | null;
    targetType: string;
    targetId: string;
    detail: string;
  }[],
): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [r.id, r.createdAt, r.action, r.actorId ?? "", r.targetType, r.targetId, r.detail]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
