/**
 * recountAll 集成测试（临时库）：在演示数据上注入计数漂移，验证
 * - 干跑（dryRun）只报告、不改库，且报告与真实执行一致；
 * - 真实执行把计数修正回明细推导值，再跑一次零修正（幂等）；
 * - 缺失的 user_stats 行会被补建。
 * 需要本机 MySQL（docker/qysub-next）；SKIP_DB_TESTS=1 可跳过。
 */
import mysql, { type RowDataPacket } from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDb } from "./bootstrap.js";
import { createDb, createPool } from "./client.js";
import { newDbConfig } from "./env.js";
import { recountAll, recountDriftTotal, type RecountReport } from "./recount.js";
import { DEMO, seedDemoData } from "./seed-data.js";

const skip = process.env.SKIP_DB_TESTS === "1";
const base = newDbConfig();
const dbName = `funwind_rc_${randomBytes(4).toString("hex")}`;
const config = { ...base, database: dbName };

const admin = async () =>
  mysql.createConnection({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    charset: "utf8mb4",
  });

/** 报告中指定表的结果（找不到即为测试失败） */
function tableOf(report: RecountReport, table: string) {
  const t = report.tables.find((x) => x.table === table);
  if (!t) throw new Error(`报告缺少表 ${table}`);
  return t;
}

describe.skipIf(skip)("recountAll 集成（临时库）", () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    const c = await admin();
    await c.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await c.end();
    await bootstrapDb(config, () => {});
    pool = createPool(config);
    await seedDemoData(createDb(pool));
    // 先把演示数据的计数拉到明细推导值，作为后续断言的基线
    await recountAll(pool);
  });

  afterAll(async () => {
    await pool?.end();
    const c = await admin();
    await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await c.end();
  });

  const scalar = async (sql: string, params: unknown[] = []) => {
    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    return rows[0] ?? {};
  };

  it("基线：全量重算之后，干跑与真实执行都零修正（幂等）", async () => {
    const dry = await recountAll(pool, { dryRun: true });
    expect(recountDriftTotal(dry)).toBe(0);
    const apply = await recountAll(pool);
    expect(recountDriftTotal(apply)).toBe(0);
  });

  it("注入漂移：干跑只报告不改库；真实执行修正；再跑归零", async () => {
    const t = await scalar("SELECT id, forum_id AS forumId FROM threads ORDER BY id LIMIT 1");
    const tid = Number(t.id);
    const fid = Number(t.forumId);

    // 三类漂移：主题回复数 + 指针错误、版块帖数、用户统计行缺失
    await pool.query("UPDATE threads SET reply_count = 777, last_post_id = 999999 WHERE id = ?", [
      tid,
    ]);
    await pool.query("UPDATE forums SET post_count = 555 WHERE id = ?", [fid]);
    await pool.query("DELETE FROM user_stats WHERE user_id = ?", [DEMO.member]);

    // 干跑：报告到漂移，但数据保持原样
    const dry = await recountAll(pool, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(tableOf(dry, "threads").rows).toBeGreaterThanOrEqual(1);
    expect(tableOf(dry, "threads").byColumn["reply_count"]).toBeGreaterThanOrEqual(1);
    expect(tableOf(dry, "forums").byColumn["post_count"]).toBeGreaterThanOrEqual(1);
    expect(tableOf(dry, "user_stats").created).toBe(1);
    expect((await scalar("SELECT reply_count AS v FROM threads WHERE id = ?", [tid])).v).toBe(777);
    expect(
      (await scalar("SELECT COUNT(*) AS n FROM user_stats WHERE user_id = ?", [DEMO.member])).n,
    ).toBe(0);

    // 真实执行：报告与干跑一致，数据被修正
    const apply = await recountAll(pool);
    expect(apply.dryRun).toBe(false);
    expect(recountDriftTotal(apply)).toBe(recountDriftTotal(dry));
    expect(tableOf(apply, "threads").byColumn).toEqual(tableOf(dry, "threads").byColumn);

    const expectReply = await scalar(
      "SELECT COUNT(*) AS n FROM posts WHERE thread_id = ? AND floor > 1 AND state = 'visible'",
      [tid],
    );
    const expectLast = await scalar(
      "SELECT id AS v FROM posts WHERE thread_id = ? AND state = 'visible' ORDER BY floor DESC LIMIT 1",
      [tid],
    );
    const fixed = await scalar(
      "SELECT reply_count AS rc, last_post_id AS lp FROM threads WHERE id = ?",
      [tid],
    );
    expect(Number(fixed.rc)).toBe(Number(expectReply.n));
    expect(Number(fixed.lp)).toBe(Number(expectLast.v));
    expect((await scalar("SELECT post_count AS v FROM forums WHERE id = ?", [fid])).v).not.toBe(
      555,
    );
    expect(
      (await scalar("SELECT COUNT(*) AS n FROM user_stats WHERE user_id = ?", [DEMO.member])).n,
    ).toBe(1);

    // 再跑：零修正
    const again = await recountAll(pool);
    expect(recountDriftTotal(again)).toBe(0);
  });
});
