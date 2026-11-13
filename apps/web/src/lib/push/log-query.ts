import "server-only";
import { and, eq, like, sql, type SQL } from "drizzle-orm";
import { getWebDb, pushLog } from "@funwind/db";
import { pageBounds, pageLimit, parseLogFilterBase } from "@/lib/paging";
import { countRows, escapeLike, pageItems } from "@/lib/sql";

/**
 * 推送发送记录查询（后台 /admin/push，M18 Step 6，镜像 lib/mail/log-query）：
 * 状态 / 场景 / endpoint 或用户 筛选 + 分页，外加最近 24 小时成败计数供页头概览。
 * 参数解析是纯函数（单测锚定非法值回退）。记录不含正文 payload。
 */

/** 首期推送场景（D2 三类）；后续扩场景在此登记 */
export const PUSH_SCENES = ["pm-received", "post-replied", "post-mentioned"] as const;

export const PUSH_SCENE_LABEL: Record<string, string> = {
  "pm-received": "私信",
  "post-replied": "回复",
  "post-mentioned": "提及",
};

export interface PushLogFilter {
  status?: "sent" | "failed";
  scene?: string;
  /** endpoint 片段或精确用户 id（纯数字） */
  q?: string;
  page?: number;
  limit?: number;
}

export interface PushLogRow {
  id: number;
  kind: string;
  scene: string;
  endpoint: string;
  userId: number | null;
  title: string;
  status: "sent" | "failed";
  error: string | null;
  messageId: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** 从查询参数解析筛选条件：枚举外的值一律忽略，页码非正整数回退 1 */
export function parsePushLogFilter(sp: Record<string, string | undefined>): PushLogFilter {
  const base = parseLogFilterBase(sp, (s) => (PUSH_SCENES as readonly string[]).includes(s));
  const status = sp.status === "sent" || sp.status === "failed" ? sp.status : undefined;
  return { status, scene: base.scene, q: base.q, page: base.page };
}

export async function queryPushLogs(
  filter: PushLogFilter = {},
): Promise<{ items: PushLogRow[]; total: number }> {
  const conds: SQL[] = [];
  if (filter.status) conds.push(eq(pushLog.status, filter.status));
  if (filter.scene) conds.push(eq(pushLog.scene, filter.scene));
  if (filter.q) {
    if (/^\d{1,10}$/.test(filter.q)) conds.push(eq(pushLog.userId, Number(filter.q)));
    else conds.push(like(pushLog.endpoint, `%${escapeLike(filter.q)}%`));
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  const total = await countRows(pushLog, where);
  const limit = pageLimit(filter.limit);
  const { offset } = pageBounds(total, filter.page ?? 1, limit);
  const items = await pageItems(pushLog, where, limit, offset);
  return { items: items as PushLogRow[], total };
}

/** 最近 24 小时成败计数（页头概览） */
export async function pushLogSummary(): Promise<{ sent: number; failed: number }> {
  const rows = await getWebDb()
    .select({ status: pushLog.status, n: sql<number>`COUNT(*)` })
    .from(pushLog)
    .where(sql`${pushLog.createdAt} >= NOW() - INTERVAL 1 DAY`)
    .groupBy(pushLog.status);
  const out = { sent: 0, failed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}
