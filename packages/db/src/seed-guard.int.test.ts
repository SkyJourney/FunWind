/**
 * 种子生产守卫的集成测试（临时库）：空库 / 纯演示库放行，混入真实用户后拒绝，--force 覆盖。
 * SKIP_DB_TESTS=1 时跳过（与其余 *.int.test.ts 一致）。
 */
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDb } from "./bootstrap.js";
import { createDb, createPool } from "./client.js";
import { newDbConfig } from "./env.js";
import { seedDemoData } from "./seed-data.js";
import { assertSeedAllowed, countForeignUsers } from "./seed-guard.js";
import { users } from "./schema.js";

const skip = process.env.SKIP_DB_TESTS === "1";
const base = newDbConfig();
const dbName = `funwind_it_${randomBytes(4).toString("hex")}`;
const config = { ...base, database: dbName };

const admin = async () =>
  mysql.createConnection({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    charset: "utf8mb4",
  });

describe.skipIf(skip)("种子生产守卫（临时库）", () => {
  beforeAll(async () => {
    const c = await admin();
    await c.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await c.end();
    await bootstrapDb(config, () => {});
  });
  afterAll(async () => {
    const c = await admin();
    await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await c.end();
  });

  it("空库与纯演示库放行；真实用户（含长得像演示前缀的）使其拒绝；--force 覆盖并告警", async () => {
    const pool = createPool(config);
    const logs: string[] = [];
    const log = (m: string) => void logs.push(m);
    try {
      const db = createDb(pool);
      const run = (argv: string[] = [], env: NodeJS.ProcessEnv = {}) =>
        assertSeedAllowed(db, "db:seed", ["node", "seed.ts", ...argv], env, log);

      // 空库
      expect(await countForeignUsers(db)).toBe(0);
      await expect(run()).resolves.toBeUndefined();

      // 纯演示库（可重复跑）：演示账号 + E2E 占位账号都不算外来用户
      await seedDemoData(db);
      await db.insert(users).values({
        username: "e2e_deleted_placeholder",
        usernameKey: "e2e_deleted_placeholder",
        createdAt: "2026-10-20 12:00:00",
      });
      expect(await countForeignUsers(db)).toBe(0);
      await expect(run()).resolves.toBeUndefined();
      expect(logs).toEqual([]);

      // 生产环境：即使是纯演示库也拒绝
      await expect(run([], { NODE_ENV: "production" })).rejects.toThrow(/生产守卫拒绝/);
      expect(logs.join("\n")).toContain("NODE_ENV=production");
      expect(logs.join("\n")).toContain("--force");

      // 真实用户：包括「demo」后面没有下划线的名字（LIKE 的 _ 通配必须被转义，否则 demoxadmin 会被误当演示账号）
      await db.insert(users).values([
        { username: "alice", usernameKey: "alice", createdAt: "2026-10-20 12:00:00" },
        { username: "demoxadmin", usernameKey: "demoxadmin", createdAt: "2026-10-20 12:00:00" },
      ]);
      expect(await countForeignUsers(db)).toBe(2);
      logs.length = 0;
      await expect(run()).rejects.toThrow(/生产守卫拒绝/);
      expect(logs.join("\n")).toContain("2 个非演示用户");

      // --force 覆盖：放行但留下警告
      logs.length = 0;
      await expect(run(["--force"])).resolves.toBeUndefined();
      expect(logs.join("\n")).toContain("已被 --force 覆盖");
    } finally {
      await pool.end();
    }
  });
});
