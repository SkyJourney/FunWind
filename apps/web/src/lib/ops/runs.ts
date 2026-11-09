import "server-only";

import { sql } from "drizzle-orm";
import { getWebDb } from "@funwind/db";

/**
 * 运行台账读取（M14：v1 的 backup_runs 由管线幂等演进为 ops_runs）。台账由运维任务管线自治建表与写入——
 * 职责分离，web 侧用原生 SQL 只读，不进 drizzle schema（db:verify 对它显式豁免，见 packages/db/scripts/verify.ts）。
 */

export interface OpsRunRow {
  id: number;
  kind: "db" | "storage" | "restore" | "drill" | "holiday";
  /** 任务键（v1 旧行由管线按类别回填） */
  taskKey: string | null;
  trigger: "cron" | "manual" | "once";
  status: "running" | "success" | "failed";
  path: string | null;
  sizeBytes: number | null;
  detail: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 台账表不存在（管线尚未部署或尚未完成首次引导）：mysql2 错误码，drizzle 会把它包在 cause 里 */
function isMissingTable(e: unknown): boolean {
  const err = e as { code?: string; errno?: number; cause?: { code?: string; errno?: number } };
  return [err, err?.cause].some((x) => x?.code === "ER_NO_SUCH_TABLE" || x?.errno === 1146);
}

/**
 * 最近的运行记录；台账表不存在时返回 null（零表韧性，M14 F12：v1 在这里直接抛错，运维页整页 500）。
 * 其余数据库错误照常抛出——那是真故障，不该被当成「未部署」掩盖。
 */
export async function listOpsRuns(limit = 50): Promise<OpsRunRow[] | null> {
  let result: unknown;
  try {
    result = await getWebDb().execute(sql`
      SELECT id, kind, task_key AS taskKey, trigger_source AS triggerSource, status, path,
             size_bytes AS sizeBytes, detail, error, started_at AS startedAt, finished_at AS finishedAt
      FROM ops_runs ORDER BY id DESC LIMIT ${limit}
    `);
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
  // drizzle mysql2 的 execute 返回 [rows, fields]；rows 在第一位，做防御性归一
  const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as Array<
    Record<string, unknown>
  >;
  return (rows ?? []).map((r) => ({
    id: Number(r.id),
    kind: r.kind as OpsRunRow["kind"],
    taskKey: (r.taskKey as string | null) ?? null,
    trigger: r.triggerSource as OpsRunRow["trigger"],
    status: r.status as OpsRunRow["status"],
    path: (r.path as string | null) ?? null,
    sizeBytes: r.sizeBytes === null || r.sizeBytes === undefined ? null : Number(r.sizeBytes),
    detail: (r.detail as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    startedAt: String(r.startedAt ?? ""),
    finishedAt: r.finishedAt === null || r.finishedAt === undefined ? null : String(r.finishedAt),
  }));
}
