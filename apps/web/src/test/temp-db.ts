import { randomBytes } from "node:crypto";
import {
  bootstrapDb,
  createDb,
  createPool,
  getWebPool,
  newDbConfig,
  seedDemoData,
} from "@funwind/db";

/**
 * DB 集成测试的临时库（与 packages/db 的集成测试同一套路）：
 * 随机命名 → bootstrap（建表+系统种子）→ 灌演示夹具 → 把 web 运行时单例池指向它 → 用完删库。
 * 必须在任何代码首次调用 getWebDb() 之前执行（单例池按首次调用时的 NEW_DB_NAME 建立）。
 * 需要本机 MySQL（docker/qysub-next）；确无库的环境用 SKIP_DB_TESTS=1 显式跳过。
 */

export const skipDb = process.env.SKIP_DB_TESTS === "1";

export interface TempDb {
  name: string;
  teardown: () => Promise<void>;
}

export async function setupTempDb(opts: { demo?: boolean } = {}): Promise<TempDb> {
  const base = newDbConfig();
  const name = `funwind_web_it_${randomBytes(4).toString("hex")}`;
  const admin = createPool({ ...base, database: "information_schema" });
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);

  const config = { ...base, database: name };
  await bootstrapDb(config, () => {});
  if (opts.demo !== false) {
    const pool = createPool(config);
    try {
      await seedDemoData(createDb(pool));
    } finally {
      await pool.end();
    }
  }

  // 让 web 运行时单例池连到临时库（newDbConfig 读 process.env，dotenv 不会覆盖已存在的变量）
  process.env.NEW_DB_NAME = name;

  return {
    name,
    teardown: async () => {
      await getWebPool().end();
      (globalThis as unknown as { __funwindPool?: unknown }).__funwindPool = undefined;
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await admin.end();
    },
  };
}
