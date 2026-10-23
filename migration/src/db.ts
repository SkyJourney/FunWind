import mysql from "mysql2/promise";
import { createPool } from "@funwind/db";
import { config } from "./config.js";

const DB_RE = /^\s*(select|show|describe|desc)\b/i;

/** 旧库连接：只读红线在代码层强制 —— 非 SELECT/SHOW/DESC 直接抛错 */
const oldPool = mysql.createPool({
  ...config.oldDb,
  charset: "utf8mb4",
  connectionLimit: 4,
  dateStrings: true,
  multipleStatements: false,
});

export async function oldQuery<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!DB_RE.test(sql)) {
    throw new Error(`[旧库只读] 拒绝执行非查询语句: ${sql.slice(0, 100)}`);
  }
  const [rows] = await oldPool.query(sql, params as any[]);
  return rows as T[];
}

const newPool = createPool(config.newDb);

export async function newQuery<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await newPool.query(sql, params as any[]);
  return rows as T[];
}

export type Row = Record<string, unknown>;

const q = (name: string) => `\`${name}\``;

/** 单条 INSERT 的占位符上限留足余量（MySQL 上限 65535） */
const MAX_PLACEHOLDERS = 30_000;
/** 单条 INSERT 的负载上限（字节近似）。max_allowed_packet 默认 64MB，正文很大时要按体积切分 */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

function rowBytes(row: Row, cols: string[]): number {
  let n = 0;
  for (const c of cols) {
    const v = row[c];
    if (typeof v === "string") n += v.length * 3;
    else if (v !== null && v !== undefined) n += 16;
  }
  return n;
}

/** 同时按占位符数量与负载体积切块 */
function chunkRows(rows: Row[], cols: string[]): Row[][] {
  const maxRows = Math.max(1, Math.floor(MAX_PLACEHOLDERS / cols.length));
  const out: Row[][] = [];
  let cur: Row[] = [];
  let bytes = 0;
  for (const r of rows) {
    const b = rowBytes(r, cols);
    if (cur.length > 0 && (cur.length >= maxRows || bytes + b > MAX_PAYLOAD_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += b;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function buildInsert(table: string, cols: string[], rows: Row[], upsertKeys?: string[]) {
  const placeholders = rows.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
  let sql = `INSERT INTO ${q(table)} (${cols.map(q).join(",")}) VALUES ${placeholders}`;
  if (upsertKeys) {
    const update = cols
      .filter((c) => !upsertKeys.includes(c))
      .map((c) => `${q(c)} = VALUES(${q(c)})`)
      .join(",");
    const noop = upsertKeys.map((k) => `${q(k)} = VALUES(${q(k)})`).join(",");
    sql += ` ON DUPLICATE KEY UPDATE ${update || noop}`;
  }
  return { sql, values: rows.flatMap((r) => cols.map((c) => r[c] ?? null)) };
}

/**
 * 幂等加载：按主键/唯一键 UPSERT，重跑结果一致。
 * keys 必须是表上真实存在的主键或唯一键列（v2 的唯一键都不含可空列，ON DUPLICATE 因此可靠）。
 */
export async function upsert(table: string, cols: string[], rows: Row[], keys: string[]) {
  for (const part of chunkRows(rows, cols)) {
    const { sql, values } = buildInsert(table, cols, part, keys);
    await newPool.query(sql, values);
  }
}

/**
 * 替换式加载：事务内清空整表再写入。
 * 仅用于「迁移独占」的翻译类表（role_grants / user_roles）：它们由旧数据整体推导，不存在需要保留的线上数据；
 * 好处是旧数据变化后重跑不会遗留过期授权。
 */
export async function replaceAll(table: string, cols: string[], rows: Row[]) {
  const conn = await newPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM ${q(table)}`);
    for (const part of chunkRows(rows, cols)) {
      const { sql, values } = buildInsert(table, cols, part);
      await conn.query(sql, values);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 迁移独占的表：由旧库整体推导，加载时整表替换（而不是 UPSERT）。
 * 原因：UPSERT 在转换逻辑变化后不会清理上一次留下的陈旧行（实测：门控从 2 条变 1 条，旧的第 2 条残留），
 * 使「重跑幂等」只对未变化的数据成立。整体替换保证库内容恒等于「这一次的转换结果」。
 * 身份类表（users / forums / user_profiles / site_settings）仍用 UPSERT：它们可能被安装器/运营先行写入。
 */
export const OWNED_TABLES: ReadonlySet<string> = new Set([
  "forum_prefixes",
  "user_restrictions",
  "threads",
  "posts",
  "post_gates",
  "gate_unlocks",
  "attachments",
  "tags",
  "thread_tags",
  "point_accounts",
  "point_ledger",
  "checkins",
  "badges",
  "user_badges",
  "follows",
  "reactions",
  "polls",
  "poll_options",
  "poll_votes",
  "conversations",
  "conversation_members",
  "messages",
]);

/** 按表的归属选择加载方式：独占表整体替换，其余 UPSERT */
export async function load(table: string, cols: string[], rows: Row[], keys: string[]) {
  if (OWNED_TABLES.has(table)) return replaceAll(table, cols, rows);
  return upsert(table, cols, rows, keys);
}

/**
 * 保险：迁移是一次性的全量导入，整表替换会抹掉线上产生的数据。
 * 发现线上数据（非迁移来源的积分流水、真实购买、迁移基准时间之后的帖子、审计记录）则拒绝运行；
 * 确需强制时显式设置 MIGRATION_FORCE=1。
 */
export async function assertNoLiveData(asOf: string): Promise<void> {
  if (process.env.MIGRATION_FORCE === "1") return;
  const [row] = await newQuery<Record<string, number>>(
    `SELECT (SELECT COUNT(*) FROM point_ledger WHERE channel <> 'opening') AS ledger,
            (SELECT COUNT(*) FROM gate_unlocks WHERE source = 'purchase') AS purchases,
            (SELECT COUNT(*) FROM posts WHERE created_at > ?) AS newer_posts,
            (SELECT COUNT(*) FROM audit_log) AS audits`,
    [asOf],
  );
  const live = Object.entries(row ?? {}).filter(([, n]) => Number(n) > 0);
  if (live.length > 0) {
    throw new Error(
      `检测到线上产生的数据（${live.map(([k, n]) => `${k}=${n}`).join("、")}），迁移会整表替换并抹掉它们，已拒绝运行。` +
        `确需重导请先备份，并显式设置 MIGRATION_FORCE=1。`,
    );
  }
}

/** 把自增起点推到 MAX(id)+1 之后（保留旧主键后，新记录必须从旧最大值之后分配） */
export async function bumpAutoIncrement(table: string, idCol = "id"): Promise<number> {
  const [row] = await newQuery<{ m: number | null }>(
    `SELECT MAX(${q(idCol)}) AS m FROM ${q(table)}`,
  );
  const next = Number(row?.m ?? 0) + 1;
  await newQuery(`ALTER TABLE ${q(table)} AUTO_INCREMENT = ${next}`);
  return next;
}

export async function closePools() {
  await Promise.all([oldPool.end(), newPool.end()]);
}
