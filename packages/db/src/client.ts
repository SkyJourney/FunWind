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
 * 连接层约定（基线审查 P1-2，2026-10-23；时区补强 2026-10-24 审查 P1-1）：
 * - 库内 DATETIME 一律为「北京墙面时间」（迁移 toDatetime 固定 +8）
 * - 时区要在两处同时锁定，缺一不可：
 *   · mysql2 的 timezone 选项只管客户端 Date 的序列化/解析，**不会**改变服务器会话时区；
 *   · 服务器侧 NOW() 取决于会话 time_zone（默认 SYSTEM，容器通常是 UTC），
 *     所以每条新连接必须显式 SET time_zone（见 SESSION_TIME_ZONE_SQL 与 createPool）。
 * - dateStrings: 读取按原样字符串返回，任何解析必须经 web 侧 parseDbDateTime（显式 +08:00）
 * - web 运行时用 getWebPool 单例池（globalThis 守卫，HMR 安全）；withDb 仅限一次性脚本
 */
const CONNECTION_OPTS = {
  charset: "utf8mb4",
  timezone: "+08:00",
  dateStrings: true,
  multipleStatements: false,
} as const;

/** 新连接建立后立即执行：让服务器侧 NOW() 等函数与库内「北京墙面时间」同口径 */
export const SESSION_TIME_ZONE_SQL = "SET time_zone = '+08:00'";

/** 连接池工厂：一次性脚本用（用完即 end） */
export function createPool(config = newDbConfig()) {
  const pool = mysql.createPool({
    ...config,
    ...CONNECTION_OPTS,
    connectionLimit: 8,
  });
  // 'connection' 事件在新连接建立后、交给调用方之前触发；此处入队的 SET 先于该连接上的任何后续查询执行
  pool.pool.on("connection", (conn) => {
    conn.query(SESSION_TIME_ZONE_SQL);
  });
  return pool;
}

export function createDb(pool: mysql.Pool): Db {
  // mysql2/promise 的 Pool 品牌在 drizzle d.ts 解析链下双身份（promise 增强差异），行为一致，
  // 边界处显式豁免；若上游类型修复，此 expect-error 将因未使用而报错提醒移除
  // @ts-expect-error mysql2 Pool 品牌双身份
  return drizzle(pool, { schema, mode: "default" });
}

/**
 * 取出 createDb 所用的 promise 连接池（供需要原生连接的批量重算等场景）。
 * drizzle 把 $client 标成了回调风格的 Pool 类型，运行时实际就是 createPool 建的 promise 池；
 * 与 createDb 的豁免同理，在此边界显式收口。仅用于由 createDb 产生的 db。
 */
export function poolOf(db: Db): mysql.Pool {
  return db.$client as unknown as mysql.Pool;
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
