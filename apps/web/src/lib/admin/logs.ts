import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { auditLog, eventLog, getWebDb } from "@funwind/db";
import { pageBounds } from "@/lib/queries/paging";

/**
 * 审计中心查询（M9）：audit_log 与 event_log 统一筛选/分页；CSV 行生成是纯函数（单测锚定转义）。
 */

export interface LogFilter {
  action?: string;
  actorId?: number;
  /** ISO 日期下界（含） */
  since?: string;
  limit?: number;
  /** 1-based 页码；提供时优先于 offset */
  page?: number;
  /** 0-based 直接偏移（仅 CSV / 有界内部查询使用） */
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

function boundedLimit(raw: number | undefined): number {
  return Math.min(Math.max(1, Math.trunc(raw ?? 50) || 50), 200);
}

function boundedOffset(total: number, filter: LogFilter, limit: number): number {
  if (filter.page !== undefined) return pageBounds(total, filter.page, limit).offset;
  const raw = filter.offset ?? 0;
  return Number.isFinite(raw) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(raw))) : 0;
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
  const total = Number(n);
  const limit = boundedLimit(filter.limit);
  const items = await getWebDb()
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.id))
    .limit(limit)
    .offset(boundedOffset(total, filter, limit));
  return { items: items as AuditLogRow[], total };
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
  const total = Number(n);
  const limit = boundedLimit(filter.limit);
  const items = await getWebDb()
    .select()
    .from(eventLog)
    .where(where)
    .orderBy(desc(eventLog.id))
    .limit(limit)
    .offset(boundedOffset(total, filter, limit));
  return { items: items as EventLogRowView[], total };
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
