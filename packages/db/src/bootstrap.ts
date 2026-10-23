/**
 * bootstrapDb —— 空库建表管线（零数据部署与青翼导入共用，决策 #10）
 * 1. drizzle 版本化迁移（drizzle/0000_init.sql，journal 断点续跑，幂等）
 * 2. PATCH：users.username 列级 COLLATE utf8mb4_0900_as_cs（さくら≠サクラ，P0 实测修正；
 *    drizzle-kit 不支持列级 collate，此 patch 按需执行、幂等）
 */
import { migrate } from "drizzle-orm/mysql2/migrator";
import type { RowDataPacket } from "mysql2/promise";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, createPool } from "./client.js";
import { newDbConfig } from "./env.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "../drizzle");

export async function bootstrapDb(
  config = newDbConfig(),
  log = (m: string) => console.log(m),
): Promise<void> {
  const pool = createPool(config);
  const db = createDb(pool);
  try {
    await migrate(db, { migrationsFolder });
    log("✔ 版本化迁移已应用（幂等）");
  } finally {
    await pool.end();
  }

  const patchPool = createPool(config);
  try {
    const [rows] = await patchPool.query<RowDataPacket[]>(
      `SELECT COLLATION_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'username'`,
      [config.database],
    );
    const collation = rows[0]?.COLLATION_NAME;
    if (collation === "utf8mb4_0900_as_cs") {
      log("✔ users.username 已是 utf8mb4_0900_as_cs（patch 跳过）");
    } else {
      await patchPool.query(
        "ALTER TABLE `users` MODIFY `username` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL COMMENT '区分大小写与假名（さくら≠サクラ）'",
      );
      log(`✔ users.username collation 修正：${collation} → utf8mb4_0900_as_cs`);
    }
  } finally {
    await patchPool.end();
  }
}
