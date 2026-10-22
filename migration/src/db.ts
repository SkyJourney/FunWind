import mysql from 'mysql2/promise';
import { config } from './config.js';

const DB_RE = /^\s*(select|show|describe|desc)\b/i;

/** 旧库连接：只读红线在代码层强制 —— 非 SELECT/SHOW/DESC 直接抛错 */
const oldPool = mysql.createPool({
  ...config.oldDb,
  charset: 'utf8mb4',
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

const newPool = mysql.createPool({
  ...config.newDb,
  charset: 'utf8mb4',
  connectionLimit: 8,
  dateStrings: true,
  multipleStatements: true, // 允许 schema.sql 整体执行
});

export async function newQuery<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await newPool.query(sql, params as any[]);
  return rows as T[];
}

export type Row = Record<string, unknown>;

/** 批量 UPSERT：keys 为主键列（冲突时更新全部列） */
export async function upsertBatch(table: string, cols: string[], rows: Row[], keys: string[]) {
  if (rows.length === 0) return;
  const placeholders = rows.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
  const update = cols.filter((c) => !keys.includes(c))
    .map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(',');
  const keyCheck = keys.map((k) => `\`${k}\` = VALUES(\`${k}\`)`).join(' AND ');
  const sql = `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(',')})
    VALUES ${placeholders}
    ON DUPLICATE KEY UPDATE ${update || `${keyCheck}`}`;
  const values = rows.flatMap((r) => cols.map((c) => r[c] ?? null));
  await newPool.query(sql, values);
}

/** json 列包装：undefined → null */
export function j(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

export async function closePools() {
  await Promise.all([oldPool.end(), newPool.end()]);
}
