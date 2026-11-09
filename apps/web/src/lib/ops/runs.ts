import "server-only";

import { sql } from "drizzle-orm";
import { getWebDb } from "@funwind/db";

/**
 * 运行台账与触发器状态读取（M14：v1 的 backup_runs 由管线幂等演进为 ops_runs）。台账由运维任务管线
 * 自治建表与写入——职责分离，web 侧用原生 SQL 只读，不进 drizzle schema
 * （db:verify 对它显式豁免，见 packages/db/scripts/verify.ts）。
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

/** drizzle mysql2 的 execute 返回 [rows, fields]；rows 在第一位，做防御性归一 */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return ((Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) ?? []) as Array<
    Record<string, unknown>
  >;
}

/** 触发器状态行（管线回写；web 只读展示，不复算 cron） */
export interface OpsTriggerStateRow {
  triggerKey: string;
  taskKey: string;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  lastRunId: number | null;
  lastResult: "success" | "failed" | "skipped" | null;
}

/**
 * 全部触发器状态；台账/状态表不存在（管线未部署或尚未完成首次引导）时返回 null，页面降级提示。
 * 其余数据库错误照常抛出。
 */
export async function listOpsTriggerStates(): Promise<OpsTriggerStateRow[] | null> {
  let result: unknown;
  try {
    result = await getWebDb().execute(sql`
      SELECT trigger_key AS triggerKey, task_key AS taskKey, next_fire_at AS nextFireAt,
             last_fired_at AS lastFiredAt, last_run_id AS lastRunId, last_result AS lastResult
      FROM ops_trigger_state
    `);
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
  return rowsOf(result).map((r) => ({
    triggerKey: String(r.triggerKey ?? ""),
    taskKey: String(r.taskKey ?? ""),
    nextFireAt: r.nextFireAt === null || r.nextFireAt === undefined ? null : String(r.nextFireAt),
    lastFiredAt:
      r.lastFiredAt === null || r.lastFiredAt === undefined ? null : String(r.lastFiredAt),
    lastRunId: r.lastRunId === null || r.lastRunId === undefined ? null : Number(r.lastRunId),
    lastResult: (r.lastResult as OpsTriggerStateRow["lastResult"] | null) ?? null,
  }));
}

/** 分页读取；多取一条判断 hasMore，避免为总数多发一次查询 */
const PAGE_SIZE = 25;

export interface OpsRunPage {
  rows: OpsRunRow[];
  hasMore: boolean;
  /** 台账里是否有执行中的记录（不限当前页：轮询判定不能依赖翻到第几页） */
  anyRunning: boolean;
  /** 台账表不存在（管线未部署或尚未完成首次引导） */
  ledgerMissing: boolean;
}

/** 运行台账分页（page 从 1 起）；表不存在时 ledgerMissing=true（零表韧性，M14 F12）。 */
export async function listOpsRunPage(page: number): Promise<OpsRunPage> {
  const safePage = Math.max(1, Math.floor(page) || 1);
  try {
    const [listed, running] = await Promise.all([
      getWebDb().execute(sql`
        SELECT id, kind, task_key AS taskKey, trigger_source AS triggerSource, status, path,
               size_bytes AS sizeBytes, detail, error, started_at AS startedAt, finished_at AS finishedAt
        FROM ops_runs ORDER BY id DESC LIMIT ${PAGE_SIZE + 1} OFFSET ${(safePage - 1) * PAGE_SIZE}
      `),
      getWebDb().execute(
        sql`SELECT EXISTS(SELECT 1 FROM ops_runs WHERE status = 'running') AS anyRunning`,
      ),
    ]);
    const raw = rowsOf(listed);
    return {
      rows: raw.slice(0, PAGE_SIZE).map(mapRunRow),
      hasMore: raw.length > PAGE_SIZE,
      anyRunning: Number(rowsOf(running)[0]?.anyRunning ?? 0) === 1,
      ledgerMissing: false,
    };
  } catch (e) {
    if (isMissingTable(e))
      return { rows: [], hasMore: false, anyRunning: false, ledgerMissing: true };
    throw e;
  }
}

function mapRunRow(r: Record<string, unknown>): OpsRunRow {
  return {
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
  };
}

/** 某类别最近 N 条成功记录（速览卡与恢复预览卡共用，不随台账翻页变化）；表不存在返回空 */
export async function listSuccessfulRuns(
  kind: "db" | "storage",
  limit: number,
): Promise<OpsRunRow[]> {
  try {
    const result = await getWebDb().execute(sql`
      SELECT id, kind, task_key AS taskKey, trigger_source AS triggerSource, status, path,
             size_bytes AS sizeBytes, detail, error, started_at AS startedAt, finished_at AS finishedAt
      FROM ops_runs WHERE status = 'success' AND kind = ${kind} ORDER BY id DESC LIMIT ${limit}
    `);
    return rowsOf(result).map(mapRunRow);
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
}

/**
 * 台账产物路径 → 后台下载链接。台账记的是管线容器内路径（/data/backups/db/x.sql.gz），
 * 下载路由要的是相对备份卷的路径；只认 db/*.sql.gz 与 storage/*.tgz，其余不给链接。
 */
export function backupDownloadHref(path: string | null): string | null {
  const match = path && /(?:^|\/)((?:db\/[^/]+\.sql\.gz)|(?:storage\/[^/]+\.tgz))$/.exec(path);
  return match ? `/admin/ops/download?path=${encodeURIComponent(match[1]!)}` : null;
}
