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

export function createDb(pool: mysql.Pool) {
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
