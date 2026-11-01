import { fileURLToPath } from "node:url";
import path from "node:path";
import { affectedRowsOf } from "@funwind/db";
import { oldQuery, newQuery, closePools } from "./db.js";
import { config } from "./config.js";

/**
 * 双轨密码回填核心（M10.6c）：旧库 nw_windid_user 的 phpwind MD5 哈希/盐
 * → 新库 users.legacy_password_hash / legacy_password_pending。
 *
 * 安全边界：oldQuery 只执行 SELECT；目标仅写 active 且 password_hash 与 legacy hash 均为空的账号；
 * 每条 UPDATE 原子且幂等，中断后安全重跑。默认迁移通过 legacy-password step 调用；
 * 本文件直接运行时保留独立回填命令，供恢复/补跑使用。
 */

const DEFAULT_BATCH_SIZE = 2000;

type OldQuery = (sql: string, params?: unknown[]) => Promise<unknown[]>;
type NewQuery = (sql: string, params?: unknown[]) => Promise<unknown>;

export interface LegacyPasswordBackfillStats {
  candidates: number;
  scanned: number;
  backfilled: number;
  skippedNoMaterial: number;
  skippedTarget: number;
  pending: number;
}

export interface LegacyPasswordBackfillOptions {
  oldQuery?: OldQuery;
  newQuery?: NewQuery;
  batchSize?: number;
  onProgress?: (message: string) => void;
}

/** 可注入数据库查询器，以便使用 fake-query 测试，不连接真实旧库。 */
export async function backfillLegacyPasswordHashes(
  options: LegacyPasswordBackfillOptions = {},
): Promise<LegacyPasswordBackfillStats> {
  const readOld = options.oldQuery ?? oldQuery;
  const writeNew = options.newQuery ?? newQuery;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = options.onProgress ?? (() => {});
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError("legacy password backfill batchSize must be a positive integer");
  }

  const [{ total: rawCandidates = 0 } = {}] = (await writeNew(
    "SELECT COUNT(*) AS total FROM users WHERE state = 'active' AND password_hash IS NULL",
  )) as { total?: number }[];
  const candidates = Number(rawCandidates);
  let scanned = 0;
  let backfilled = 0;
  let skippedNoMaterial = 0;
  let skippedTarget = 0;
  let maxUid = 0;

  log(`[backfill] 新库 active 且无现代密码的候选账号 ${candidates} 个`);
  for (;;) {
    const rows = (await readOld(
      "SELECT uid, password, salt FROM nw_windid_user WHERE uid > ? ORDER BY uid LIMIT ?",
      [maxUid, batchSize],
    )) as { uid: number; password: string | null; salt: string | null }[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const uid = Number(row.uid);
      maxUid = uid;
      scanned++;
      if (!row.password || !/^[0-9a-f]{32}$/i.test(row.password) || !row.salt) {
        skippedNoMaterial++;
        continue;
      }

      const stored = `md5$${row.password}$${row.salt}`;
      const affectedRows = affectedRowsOf(
        await writeNew(
          "UPDATE users SET legacy_password_hash = ?, legacy_password_pending = 1 " +
            "WHERE id = ? AND state = 'active' AND password_hash IS NULL AND legacy_password_hash IS NULL",
          [stored, uid],
        ),
      );
      if (affectedRows > 0) backfilled++;
      else skippedTarget++;
    }
    log(`[backfill] 已扫描到 uid=${maxUid}（本批 ${rows.length}）`);
  }

  const [{ done: rawPending = 0 } = {}] = (await writeNew(
    "SELECT COUNT(*) AS done FROM users WHERE legacy_password_pending = 1",
  )) as { done?: number }[];
  const stats = {
    candidates,
    scanned,
    backfilled,
    skippedNoMaterial,
    skippedTarget,
    pending: Number(rawPending),
  };
  log(
    `[backfill] 完成：候选 ${candidates}，扫描 ${scanned}，回填 ${backfilled}，` +
      `无旧材料跳过 ${skippedNoMaterial}，目标状态不符/已有凭据跳过 ${skippedTarget}；` +
      `新库 pending 总数 ${stats.pending}`,
  );
  return stats;
}

async function main(): Promise<void> {
  try {
    await backfillLegacyPasswordHashes({ onProgress: console.log });
    console.log(`[backfill] 目标库 ${config.newDb.database}`);
  } finally {
    await closePools();
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error("[backfill] 失败：", error);
    process.exitCode = 1;
  });
}
