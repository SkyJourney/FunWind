import { config as loadEnv } from "dotenv";
import path from "node:path";
import mysql from "mysql2/promise";

/**
 * E2E 用例直连 e2e 隔离库造夹具/读状态（原生 SQL）。
 * 为什么不复用 @funwind/db：Playwright 以 CJS 加载用例，而该包是纯 ESM（用到 import.meta）。
 * 库名固定为 qysub_next_e2e（playwright.config.ts 在进程启动时设置 NEW_DB_NAME），连接参数读仓库根 .env。
 * 每次调用单独建连接、用完即关，避免连接泄漏拖住 Playwright 工作进程退出。
 */
loadEnv({ path: path.resolve(__dirname, "../../../../.env"), override: false, quiet: true });

export const E2E_DB = "qysub_next_e2e";

export type Q = {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  exec: (sql: string, params?: unknown[]) => Promise<{ insertId: number; affectedRows: number }>;
};

export async function withE2eDb<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  if (process.env.NEW_DB_NAME !== E2E_DB) {
    throw new Error(`E2E 只允许连接 ${E2E_DB}，当前 NEW_DB_NAME=${process.env.NEW_DB_NAME}`);
  }
  const conn = await mysql.createConnection({
    host: process.env.NEW_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.NEW_DB_PORT ?? 33621),
    user: process.env.NEW_DB_USER ?? "root",
    password: process.env.NEW_DB_PASSWORD ?? "",
    database: E2E_DB,
    charset: "utf8mb4",
    timezone: "+08:00",
    dateStrings: true,
  });
  // 与 @funwind/db 的 createPool 同口径：服务器侧 NOW() 必须是北京墙面时间（timezone 选项不改会话时区）
  await conn.query("SET time_zone = '+08:00'");
  try {
    return await fn({
      query: async <R>(sql: string, params: unknown[] = []) =>
        (await conn.query(sql, params))[0] as R[],
      exec: async (sql, params = []) => {
        const [res] = await conn.query(sql, params);
        const r = res as { insertId: number; affectedRows: number };
        return { insertId: Number(r.insertId), affectedRows: Number(r.affectedRows) };
      },
    });
  } finally {
    await conn.end();
  }
}
