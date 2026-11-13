import "server-only";

import { sql } from "drizzle-orm";
import { cspReports, getWebDb } from "@funwind/db";
import { nowBeijingWallTime } from "@/lib/datetime";

/**
 * CSP 违规报告落库（M17 Step 6）。只负责写库——**脱敏在路由层完成**
 * （extractReports 已对 URI 字段 redactUri、其余 clean），传进来的行必须已脱敏。
 * 与 rum/ingest 同款：写侧概率清扫 90 天，不依赖 SCHEDULER。
 */

const RETENTION_DAYS = 90;
const SWEEP_PROBABILITY = 0.01;

/** 路由 extractReports 产出的已脱敏行（键为 CSP 报告字段名） */
export type CspReportRow = Record<string, string>;

function toRow(r: CspReportRow) {
  const line = Number(r["line-number"]);
  return {
    violatedDirective: (r["violated-directive"] ?? "unknown").slice(0, 64),
    effectiveDirective: r["effective-directive"]?.slice(0, 64) ?? null,
    blockedUri: r["blocked-uri"]?.slice(0, 200) ?? null,
    documentUri: r["document-uri"]?.slice(0, 200) ?? null,
    sourceFile: r["source-file"]?.slice(0, 200) ?? null,
    lineNumber: Number.isInteger(line) && line >= 0 ? line : null,
    disposition: r["disposition"]?.slice(0, 16) ?? null,
  };
}

async function sweepExpired(): Promise<void> {
  try {
    await getWebDb().execute(
      sql`DELETE FROM csp_reports WHERE created_at < NOW() - INTERVAL ${sql.raw(String(RETENTION_DAYS))} DAY LIMIT 1000`,
    );
  } catch {
    // 清理失败不反噬本批写入；下一轮概率触发再试
  }
}

/** 批量写入已脱敏报告，返回行数；1% 概率触发超期清理 */
export async function recordCspReports(rows: readonly CspReportRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const createdAt = nowBeijingWallTime();
  await getWebDb()
    .insert(cspReports)
    .values(rows.map((r) => ({ ...toRow(r), createdAt })));
  if (Math.random() < SWEEP_PROBABILITY) await sweepExpired();
  return rows.length;
}
