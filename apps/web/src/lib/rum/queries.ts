import "server-only";

import { and, desc, eq, like, sql, type SQL } from "drizzle-orm";
import { getWebDb, rumSamples } from "@funwind/db";
import { pageBounds, pageLimit, parsePageParam } from "@/lib/paging";
import { countRows, escapeLike, pageItems } from "@/lib/sql";
import { RUM_ERROR_NAMES, RUM_VITAL_NAMES } from "./protocol";

/**
 * RUM 样本查询（后台 /admin/rum，M17 Step 5）：类别 / 指标名 / 路径 筛选 + 分页，
 * 外加最近 24 小时概览与按指标名的 p75（JS nearest-rank，不引 SQL 窗口函数新范式）。
 * 参数解析是纯函数（单测锚定非法值回退），照 lib/mail/log-query.ts。
 *
 * 与 scripts/lcp.ts 的单点门禁**对照而非替代**：那个是构建后本机/公网单测，这里是真实用户分布。
 */

export const RUM_KINDS = ["vital", "error"] as const;
export type RumKind = (typeof RUM_KINDS)[number];
export const RUM_KIND_LABEL: Record<RumKind, string> = { vital: "指标", error: "错误" };

const ALL_NAMES: readonly string[] = [...RUM_VITAL_NAMES, ...RUM_ERROR_NAMES];

export interface RumFilter {
  kind?: RumKind;
  name?: string;
  /** 路径前缀包含 */
  route?: string;
  page?: number;
  limit?: number;
}

export interface RumRow {
  id: number;
  kind: RumKind;
  name: string;
  value: number;
  route: string;
  detail: string | null;
  createdAt: string;
}

/** 从查询参数解析筛选：枚举外的值一律忽略，页码非正整数回退 1 */
export function parseRumFilter(sp: Record<string, string | undefined>): RumFilter {
  const filter: RumFilter = {};
  if (sp.kind === "vital" || sp.kind === "error") filter.kind = sp.kind;
  if (sp.name && ALL_NAMES.includes(sp.name)) filter.name = sp.name;
  const route = sp.route?.trim();
  if (route) filter.route = route.slice(0, 200);
  filter.page = parsePageParam(sp.page);
  return filter;
}

export async function queryRumSamples(
  filter: RumFilter = {},
): Promise<{ items: RumRow[]; total: number }> {
  const conds: SQL[] = [];
  if (filter.kind) conds.push(eq(rumSamples.kind, filter.kind));
  if (filter.name) conds.push(eq(rumSamples.name, filter.name));
  if (filter.route) conds.push(like(rumSamples.route, `%${escapeLike(filter.route)}%`));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const total = await countRows(rumSamples, where);
  const limit = pageLimit(filter.limit);
  const { offset } = pageBounds(total, filter.page ?? 1, limit);
  const items = await pageItems(rumSamples, where, limit, offset);
  return { items: items as RumRow[], total };
}

/** 最近 24 小时指标/错误计数（页头概览） */
export async function rumSummary(): Promise<{ vitals: number; errors: number }> {
  const rows = await getWebDb()
    .select({ kind: rumSamples.kind, n: sql<number>`COUNT(*)` })
    .from(rumSamples)
    .where(sql`${rumSamples.createdAt} >= NOW() - INTERVAL 1 DAY`)
    .groupBy(rumSamples.kind);
  const out = { vitals: 0, errors: 0 };
  for (const r of rows) {
    if (r.kind === "vital") out.vitals = Number(r.n);
    else out.errors = Number(r.n);
  }
  return out;
}

/** nearest-rank 分位数（与 scripts/perf-posting.ts 同算法）；sorted 必须升序、非空 */
export function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** 每个指标名取最近 N 条算 p75，限制内存；公测期量小，N 足够代表 */
const P75_SAMPLE_CAP = 5000;

export interface RumPercentile {
  name: string;
  count: number;
  p75: number;
}

/** 最近 24 小时各 vital 指标的 p75（LCP/INP 毫秒；CLS 为 ×1000 值） */
export async function rumPercentiles(): Promise<RumPercentile[]> {
  const out: RumPercentile[] = [];
  for (const name of RUM_VITAL_NAMES) {
    const rows = await getWebDb()
      .select({ value: rumSamples.value })
      .from(rumSamples)
      .where(
        and(
          eq(rumSamples.kind, "vital"),
          eq(rumSamples.name, name),
          sql`${rumSamples.createdAt} >= NOW() - INTERVAL 1 DAY`,
        ),
      )
      .orderBy(desc(rumSamples.id))
      .limit(P75_SAMPLE_CAP);
    if (rows.length === 0) continue;
    const sorted = rows.map((r) => r.value).sort((a, b) => a - b);
    out.push({ name, count: rows.length, p75: percentile(sorted, 75) });
  }
  return out;
}
