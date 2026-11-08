import "server-only";

import { sql } from "drizzle-orm";
import { getWebDb } from "@funwind/db";

export interface BackupRunRow {
  id: number;
  kind: "db" | "storage" | "restore";
  trigger: "cron" | "manual";
  status: "running" | "success" | "failed";
  path: string | null;
  sizeBytes: number | null;
  detail: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * 备份元数据读取（`backup_runs` 表由备份服务自治建表与写入——职责分离，
 * web 侧用原生 SQL 只读查询，不进 drizzle schema（schema-rules 的运行时 schema 不认识运维表））。
 */
export async function listBackupRuns(limit = 50): Promise<BackupRunRow[]> {
  const result = await getWebDb().execute(sql`
    SELECT id, kind, trigger_source AS triggerSource, status, path, size_bytes AS sizeBytes,
           detail, error, started_at AS startedAt, finished_at AS finishedAt
    FROM backup_runs ORDER BY id DESC LIMIT ${limit}
  `);
  // drizzle mysql2 的 execute 返回 [rows, fields]；rows 在第一位，做防御性归一
  const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as Array<
    Record<string, unknown>
  >;
  return (rows ?? []).map((r) => ({
    id: Number(r.id),
    kind: r.kind as BackupRunRow["kind"],
    trigger: r.triggerSource as BackupRunRow["trigger"],
    status: r.status as BackupRunRow["status"],
    path: (r.path as string | null) ?? null,
    sizeBytes: r.sizeBytes === null || r.sizeBytes === undefined ? null : Number(r.sizeBytes),
    detail: (r.detail as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    startedAt: String(r.startedAt ?? ""),
    finishedAt: r.finishedAt === null || r.finishedAt === undefined ? null : String(r.finishedAt),
  }));
}

interface BackupServiceConfig {
  baseUrl: string;
  token: string;
}

/** 备份服务连接配置；未配置时后台展示「未部署」状态而非报错（本地开发常态）。 */
export function backupServiceConfig(): BackupServiceConfig | null {
  const baseUrl = process.env.BACKUP_SERVICE_URL;
  const token = process.env.BACKUP_OPS_TOKEN;
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

/** 触发备份服务立即执行一次备份（kind: db | storage）。服务未部署返回 null。 */
export async function triggerBackup(
  kind: "db" | "storage",
): Promise<
  | { ok: true; runId: number }
  | { ok: false; code: "unconfigured" | "busy" | "failed"; message: string }
> {
  const cfg = backupServiceConfig();
  if (!cfg)
    return {
      ok: false,
      code: "unconfigured",
      message: "备份服务未配置（BACKUP_SERVICE_URL / BACKUP_OPS_TOKEN）",
    };
  try {
    const res = await fetch(`${cfg.baseUrl}/runs?kind=${kind}`, {
      method: "POST",
      headers: { "x-ops-token": cfg.token },
      signal: AbortSignal.timeout(1800_000), // storage 全量可能数十秒；db 秒级
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string };
      return { ok: false, code: "busy", message: body.detail ?? "已有任务在执行" };
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string };
      return { ok: false, code: "failed", message: body.detail ?? `备份服务返回 ${res.status}` };
    }
    const body = (await res.json()) as { run_id: number };
    return { ok: true, runId: body.run_id };
  } catch (e) {
    return {
      ok: false,
      code: "failed",
      message: `备份服务不可达：${(e as Error).message.slice(0, 200)}`,
    };
  }
}

/** 备份服务自身健康（供运维页展示；未配置返回 null）。 */
export async function backupServiceHealth(): Promise<{ ok: boolean; jobs: string[] } | null> {
  const cfg = backupServiceConfig();
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.baseUrl}/health`, {
      headers: { "x-ops-token": cfg.token },
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok?: boolean; scheduler_jobs?: string[] };
    return { ok: Boolean(body.ok), jobs: body.scheduler_jobs ?? [] };
  } catch {
    return { ok: false, jobs: [] };
  }
}

/** 保留策略（site_settings key=ops.backup.policy；备份服务轮转时动态读取，改完即生效） */
export interface BackupPolicy {
  keepDb: number;
  keepStorage: number;
}

const POLICY_KEY = "ops.backup.policy";

export async function getBackupPolicy(): Promise<BackupPolicy> {
  const result = await getWebDb().execute(sql`
    SELECT value FROM site_settings WHERE ${sql.raw("`key`")} = ${POLICY_KEY} LIMIT 1
  `);
  const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as Array<{
    value: unknown;
  }>;
  const raw = rows[0]?.value;
  const parsed =
    typeof raw === "string" ? JSON.parse(raw) : (raw as Partial<BackupPolicy> | undefined);
  return {
    keepDb: clampKeep(parsed?.keepDb, 14),
    keepStorage: clampKeep(parsed?.keepStorage, 7),
  };
}

function clampKeep(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 90) return fallback;
  return n;
}

export async function setBackupPolicy(policy: BackupPolicy): Promise<void> {
  const value = JSON.stringify({ keepDb: policy.keepDb, keepStorage: policy.keepStorage });
  await getWebDb().execute(sql`
    INSERT INTO site_settings (${sql.raw("`key`")}, value, updated_at)
    VALUES (${POLICY_KEY}, ${value}, NOW())
    ON DUPLICATE KEY UPDATE value = ${value}, updated_at = NOW()
  `);
}
