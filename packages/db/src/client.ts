import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema.js";
import { newDbConfig } from "./env.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbContext {
  db: Db;
  pool: mysql.Pool;
}

/** 连接池工厂：web 与 migration 共用（utf8mb4，拒绝过小超时） */
export function createPool(config = newDbConfig()) {
  return mysql.createPool({
    ...config,
    charset: "utf8mb4",
    connectionLimit: 8,
    dateStrings: true,
    multipleStatements: false,
  });
}

export function createDb(pool: mysql.Pool): Db {
  // mysql2/promise 的 Pool 品牌在 drizzle d.ts 解析链下双身份（promise 增强差异），行为一致，
  // 边界处显式豁免；若上游类型修复，此 expect-error 将因未使用而报错提醒移除
  // @ts-expect-error mysql2 Pool 品牌双身份
  return drizzle(pool, { schema, mode: "default" });
}

/** 脚本便捷入口：建池 + 建 db + 收尾关闭 */
export async function withDb<T>(fn: (ctx: DbContext) => Promise<T>): Promise<T> {
  const pool = createPool();
  const db = createDb(pool);
  try {
    return await fn({ db, pool });
  } finally {
    await pool.end();
  }
}

export { schema };
