import "server-only";

import { and, desc, eq, like, sql, type SQL } from "drizzle-orm";
import { cspReports, getWebDb } from "@funwind/db";
import { pageBounds, pageLimit, parsePageParam } from "@/lib/paging";
import { countRows, escapeLike, pageItems } from "@/lib/sql";

/**
 * CSP 违规报告查询（后台 /admin/csp，M17 Step 6）：指令 / 文档路径 筛选 + 分页，
 * 外加最近 24 小时计数与 Top 指令，作为 Report-Only 转强制的数据前提。
 * 参数解析纯函数（单测锚定非法值回退）；分页复用 lib/paging + lib/sql 共享件。
 *
 * **转强制评估口径**：只有当观察窗口内（覆盖前后台主要路径）违规清零，才考虑把
 * security-headers 的 Report-Only 头转强制；否则只交报告面、诚实不转。
 */

export interface CspFilter {
  directive?: string;
  document?: string;
  page?: number;
  limit?: number;
}

export interface CspRow {
  id: number;
  violatedDirective: string;
  effectiveDirective: string | null;
  blockedUri: string | null;
  documentUri: string | null;
  sourceFile: string | null;
  lineNumber: number | null;
  disposition: string | null;
  createdAt: string;
}

/** 枚举外/超长值忽略，页码非正整数回退 1 */
export function parseCspFilter(sp: Record<string, string | undefined>): CspFilter {
  const filter: CspFilter = {};
  const directive = sp.directive?.trim();
  if (directive) filter.directive = directive.slice(0, 64);
  const document = sp.document?.trim();
  if (document) filter.document = document.slice(0, 200);
  filter.page = parsePageParam(sp.page);
  return filter;
}

export async function queryCspReports(
  filter: CspFilter = {},
): Promise<{ items: CspRow[]; total: number }> {
  const conds: SQL[] = [];
  if (filter.directive) conds.push(eq(cspReports.violatedDirective, filter.directive));
  if (filter.document) conds.push(like(cspReports.documentUri, `%${escapeLike(filter.document)}%`));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const total = await countRows(cspReports, where);
  const limit = pageLimit(filter.limit);
  const { offset } = pageBounds(total, filter.page ?? 1, limit);
  const items = await pageItems(cspReports, where, limit, offset);
  return { items: items as CspRow[], total };
}

/** 最近 24 小时违规总数 + Top 指令（页头概览，转强制评估用） */
export async function cspSummary(): Promise<{
  recent: number;
  top: { directive: string; n: number }[];
}> {
  const window = sql`${cspReports.createdAt} >= NOW() - INTERVAL 1 DAY`;
  const recent = await countRows(cspReports, window);
  const rows = await getWebDb()
    .select({ directive: cspReports.violatedDirective, n: sql<number>`COUNT(*)` })
    .from(cspReports)
    .where(window)
    .groupBy(cspReports.violatedDirective)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(5);
  return { recent, top: rows.map((r) => ({ directive: r.directive, n: Number(r.n) })) };
}
