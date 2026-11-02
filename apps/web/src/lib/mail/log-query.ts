import { and, desc, eq, like, sql, type SQL } from "drizzle-orm";
import { emailLog, getWebDb } from "@funwind/db";
import { pageBounds } from "@/lib/queries/paging";
import type { MailKind } from "./types";

/**
 * 发送记录查询（后台 /admin/mail）：状态 / 类别 / 场景 / 收件人或用户 筛选 + 分页，
 * 外加最近 24 小时成败计数供页头概览。参数解析是纯函数（单测锚定非法值回退）。
 */

export const MAIL_KINDS: readonly MailKind[] = ["verify", "security", "notice", "digest", "system"];

export const MAIL_KIND_LABEL: Record<MailKind, string> = {
  verify: "验证",
  security: "安全",
  notice: "通知",
  digest: "汇总",
  system: "系统",
};

export interface EmailLogFilter {
  status?: "sent" | "failed";
  kind?: MailKind;
  scene?: string;
  /** 收件人包含（邮箱片段）或精确用户 id（纯数字） */
  q?: string;
  page?: number;
  limit?: number;
}

export interface EmailLogRow {
  id: number;
  kind: string;
  scene: string;
  toEmail: string;
  userId: number | null;
  subject: string;
  status: "sent" | "failed";
  error: string | null;
  messageId: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** 从查询参数解析筛选条件：枚举外的值一律忽略，页码非正整数回退 1 */
export function parseEmailLogFilter(sp: Record<string, string | undefined>): EmailLogFilter {
  const filter: EmailLogFilter = {};
  if (sp.status === "sent" || sp.status === "failed") filter.status = sp.status;
  if (sp.kind && (MAIL_KINDS as readonly string[]).includes(sp.kind))
    filter.kind = sp.kind as MailKind;
  const scene = sp.scene?.trim();
  if (scene && /^[a-z0-9-]{1,48}$/.test(scene)) filter.scene = scene;
  const q = sp.q?.trim();
  if (q) filter.q = q.slice(0, 120);
  const page = Number(sp.page ?? "1");
  filter.page = Number.isInteger(page) && page > 0 ? page : 1;
  return filter;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function queryEmailLogs(
  filter: EmailLogFilter = {},
): Promise<{ items: EmailLogRow[]; total: number }> {
  const conds: SQL[] = [];
  if (filter.status) conds.push(eq(emailLog.status, filter.status));
  if (filter.kind) conds.push(eq(emailLog.kind, filter.kind));
  if (filter.scene) conds.push(eq(emailLog.scene, filter.scene));
  if (filter.q) {
    if (/^\d{1,10}$/.test(filter.q)) conds.push(eq(emailLog.userId, Number(filter.q)));
    else conds.push(like(emailLog.toEmail, `%${escapeLike(filter.q)}%`));
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  const [{ n }] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(emailLog)
    .where(where);
  const total = Number(n);
  const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 50) || 50), 200);
  const { offset } = pageBounds(total, filter.page ?? 1, limit);
  const items = await getWebDb()
    .select()
    .from(emailLog)
    .where(where)
    .orderBy(desc(emailLog.id))
    .limit(limit)
    .offset(offset);
  return { items: items as EmailLogRow[], total };
}

/** 最近 24 小时成败计数（页头概览） */
export async function emailLogSummary(): Promise<{ sent: number; failed: number }> {
  const rows = await getWebDb()
    .select({ status: emailLog.status, n: sql<number>`COUNT(*)` })
    .from(emailLog)
    .where(sql`${emailLog.createdAt} >= NOW() - INTERVAL 1 DAY`)
    .groupBy(emailLog.status);
  const out = { sent: 0, failed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}
