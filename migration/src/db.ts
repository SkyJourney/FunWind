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

function chunkRows<T>(rows: T[], colCount: number): T[][] {
  const size = Math.max(1, Math.floor(MAX_PLACEHOLDERS / colCount));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
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
  for (const part of chunkRows(rows, cols.length)) {
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
    for (const part of chunkRows(rows, cols.length)) {
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
