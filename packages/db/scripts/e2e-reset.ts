/**
 * E2E 数据库重置（基线审查 P2-d）：
 * 仅 drop + create 空库；随后的 migrate（自动建表+导入真实数据）与 db:seed（演示数据）
 * 由根 test:e2e 编排串联——E2E 因此同时拥有真实内容与库隔离。
 * 用法：NEW_DB_NAME=qysub_next_e2e tsx scripts/e2e-reset.ts
 */
import mysql from "mysql2/promise";
import { newDbConfig } from "../src/env.js";
import { assertE2eResetTarget, E2E_DATABASE_NAME } from "../src/e2e-safety.js";

const base = newDbConfig();
const database = process.env.NEW_DB_NAME ?? E2E_DATABASE_NAME;
assertE2eResetTarget(database, base.host);

console.log(`→ E2E 库重置（空库）: ${database} @ ${base.host}:${base.port}`);
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
console.log(`✔ 空库就绪（建表/导入/种子由编排后续步骤完成）: ${database}`);
