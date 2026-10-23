/**
 * E2E 数据库重置（基线审查 P2-d）：独立于本地开发库，杜绝测试污染。
 * 用法：NEW_DB_NAME=qysub_next_e2e tsx scripts/e2e-reset.ts（由根 test:e2e 编排）
 * 流程：drop → create → bootstrap（全部迁移）→ seed（幂等演示数据）
 */
import mysql from "mysql2/promise";
import { bootstrapDb } from "../src/bootstrap.js";
import { createDb, createPool } from "../src/client.js";
import { newDbConfig } from "../src/env.js";
import { seedDemoData } from "../src/seed-data.js";

const DB_NAME_RE = /^[a-z0-9_]+$/;
const base = newDbConfig();
const database = process.env.NEW_DB_NAME ?? "qysub_next_e2e";
if (!DB_NAME_RE.test(database)) {
  throw new Error(`非法数据库名: ${database}`);
}

console.log(`→ E2E 库重置: ${database} @ ${base.host}:${base.port}`);

// 1. drop + create（不带 database 连接服务器）
const admin = await mysql.createConnection({
  host: base.host,
  port: base.port,
  user: base.user,
  password: base.password,
  charset: "utf8mb4",
});
await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
await admin.query(
  `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
);
await admin.end();

// 2. bootstrap + seed（与零数据部署/开发种子同一管线）
const target = { ...base, database };
await bootstrapDb(target, () => {});
const pool = createPool(target);
const db = createDb(pool);
try {
  await seedDemoData(db);
} finally {
  await pool.end();
}

console.log(`✔ E2E 库就绪: ${database}`);
