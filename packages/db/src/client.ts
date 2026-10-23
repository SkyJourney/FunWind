import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema.js";
import { newDbConfig } from "./env.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbContext {
  db: Db;
  pool: mysql.Pool;
}

/**
 * 连接层约定（基线审查 P1-2，2026-10-23）：
 * - 库内 DATETIME 一律为「北京墙面时间」（迁移 toDatetime 固定 +8；本层 timezone 锁定
 *   Date 序列化/解析语义，不随进程/容器时区漂移）
 * - dateStrings: 读取按原样字符串返回，任何解析必须经 web 侧 parseDbDateTime（显式 +08:00）
 * - web 运行时用 getWebPool 单例池（globalThis 守卫，HMR 安全）；withDb 仅限一次性脚本
 */
const CONNECTION_OPTS = {
  charset: "utf8mb4",
  timezone: "+08:00",
  dateStrings: true,
  multipleStatements: false,
} as const;

/** 连接池工厂：一次性脚本用（用完即 end） */
export function createPool(config = newDbConfig()) {
  return mysql.createPool({
    ...config,
    ...CONNECTION_OPTS,
    connectionLimit: 8,
  });
}

export function createDb(pool: mysql.Pool): Db {
  // mysql2/promise 的 Pool 品牌在 drizzle d.ts 解析链下双身份（promise 增强差异），行为一致，
  // 边界处显式豁免；若上游类型修复，此 expect-error 将因未使用而报错提醒移除
  // @ts-expect-error mysql2 Pool 品牌双身份
  return drizzle(pool, { schema, mode: "default" });
}

/** web 运行时单例池：进程内复用（globalThis 守卫，next dev HMR 下不会重复建池） */
export function getWebPool(config = newDbConfig()): mysql.Pool {
  const g = globalThis as unknown as { __funwindPool?: mysql.Pool };
  if (!g.__funwindPool) {
    g.__funwindPool = createPool(config);
  }
  return g.__funwindPool;
}

/** web 运行时单例 db：RSC/Route Handler 直接使用 */
export function getWebDb(config = newDbConfig()): Db {
  return createDb(getWebPool(config));
}

/** 脚本便捷入口：建池 + 建 db + 收尾关闭（勿在 web 运行时使用） */
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
