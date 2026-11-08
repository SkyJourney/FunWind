/**
 * 安装 CLI E2E 的专用重置（M12 Step 5）：仅 drop + create 空库 `qysub_next_install_cli`，
 * **不 bootstrap 不 seed**——空库正是 install:cli 管线的起点（向导 E2E 同理）。
 * 护栏与 e2e-reset 同款（库名写死 + 仅 loopback），互不通用。
 * 用法：NEW_DB_NAME=qysub_next_install_cli tsx scripts/install-cli-reset.ts
 */
import mysql from "mysql2/promise";
import { newDbConfig } from "../src/env.js";
import { assertInstallCliResetTarget, INSTALL_CLI_DATABASE_NAME } from "../src/e2e-safety.js";

const base = newDbConfig();
const database = process.env.NEW_DB_NAME ?? INSTALL_CLI_DATABASE_NAME;
assertInstallCliResetTarget(database, base.host);

console.log(`→ 安装 CLI E2E 库重置（空库）: ${database} @ ${base.host}:${base.port}`);
const admin = await mysql.createConnection({
  host: base.host,
  port: base.port,
  user: base.user,
  password: base.password,
  charset: "utf8mb4",
});
await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
await admin.query(
  `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
);
await admin.end();
console.log(`✔ 空库就绪（install:cli 将自行建库表与数据）: ${database}`);
