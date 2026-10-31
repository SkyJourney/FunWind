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
  const previousDbName = process.env.NEW_DB_NAME;
  const admin = createPool({ ...base, database: "information_schema" });
  let created = false;
  let databaseDropped = false;
  let adminClosed = false;
  let runtimePoolClosed = false;
  let tornDown = false;
  let teardownPromise: Promise<void> | null = null;
  const restoreDbName = () => {
    if (previousDbName === undefined) delete process.env.NEW_DB_NAME;
    else process.env.NEW_DB_NAME = previousDbName;
  };
  const dropDatabase = async () => {
    if (databaseDropped) return;
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
        databaseDropped = true;
        return;
      } catch (error) {
        failure = error;
        if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    throw failure;
  };
  try {
    await admin.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;

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
        if (tornDown) return;
        if (teardownPromise) return teardownPromise;
        teardownPromise = (async () => {
          let poolError: unknown;
          if (!runtimePoolClosed) {
            try {
              await getWebPool().end();
            } catch (error) {
              poolError = error;
            } finally {
              (globalThis as unknown as { __funwindPool?: unknown }).__funwindPool = undefined;
              runtimePoolClosed = true;
            }
          }
          try {
            await dropDatabase();
          } finally {
            restoreDbName();
          }
          if (!adminClosed) {
            await admin.end();
            adminClosed = true;
          }
          tornDown = databaseDropped && adminClosed;
          if (poolError) throw poolError;
        })();
        try {
          await teardownPromise;
        } catch (error) {
          teardownPromise = null;
          throw error;
        }
        if (tornDown) teardownPromise = null;
      },
    };
  } catch (error) {
    let cleanupError: unknown;
    if (created) {
      try {
        await dropDatabase();
      } catch (failure) {
        cleanupError = failure;
      }
    }
    try {
      await admin.end();
      adminClosed = true;
    } catch (failure) {
      cleanupError ??= failure;
    }
    restoreDbName();
    if (cleanupError)
      throw new AggregateError([error, cleanupError], "临时库初始化失败且清理未完成");
    throw error;
  }
}
