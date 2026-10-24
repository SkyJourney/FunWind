/**
 * 结构完整性检查的集成测试（临时库）：演示数据为零；逐类注入异常，断言对应检查能发现。
 * 每一类注入都在 finally 中还原，保证用例互不影响。SKIP_DB_TESTS=1 时跳过。
 */
import mysql, { type RowDataPacket } from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDb } from "./bootstrap.js";
import { createDb, createPool } from "./client.js";
import { newDbConfig } from "./env.js";
import { findStructuralAnomalies } from "./integrity.js";
import { DEMO, seedDemoData } from "./seed-data.js";

const skip = process.env.SKIP_DB_TESTS === "1";
const base = newDbConfig();
const dbName = `funwind_si_${randomBytes(4).toString("hex")}`;
const config = { ...base, database: dbName };
/** 演示主题 900001：有两条回帖（楼层 2 为 900002），用于注入各类异常 */
const TID = 900001;

const admin = async () =>
  mysql.createConnection({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    charset: "utf8mb4",
  });

describe.skipIf(skip)("结构完整性检查（临时库）", () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    const c = await admin();
    await c.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await c.end();
    await bootstrapDb(config, () => {});
    pool = createPool(config);
    await seedDemoData(createDb(pool));
  });

  afterAll(async () => {
    await pool?.end();
    const c = await admin();
    await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await c.end();
  });

  const one = async (sql: string, params: unknown[] = []) => {
    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    return rows[0] ?? {};
  };

  it("演示数据为零：各项异常计数均为 0，唯一索引完整", async () => {
    expect(await findStructuralAnomalies(pool)).toEqual({
      orphanPosts: 0,
      orphanThreads: 0,
      orphanPostGates: 0,
      orphanAttachments: 0,
      floorIndexOk: true,
      floorDuplicates: 0,
      firstPostMissing: 0,
      stateMismatch: 0,
    });
  });

  it("孤儿引用：帖→主题、主题→版块、门控→帖、附件→帖各被发现", async () => {
    const reply = await one("SELECT id FROM posts WHERE thread_id = ? AND floor = 2", [TID]);
    const gate = await one(
      "SELECT id, post_id AS postId FROM post_gates WHERE post_id = ? LIMIT 1",
      [DEMO.gatePost],
    );
    const thread = await one("SELECT forum_id AS forumId FROM threads WHERE id = ?", [TID]);
    const BOGUS = 999999;

    // 1) 帖→主题：把一条回帖挂到不存在的主题上
    await pool.query("UPDATE posts SET thread_id = ? WHERE id = ?", [BOGUS, reply.id]);
    try {
      expect((await findStructuralAnomalies(pool)).orphanPosts).toBe(1);
    } finally {
      await pool.query("UPDATE posts SET thread_id = ? WHERE id = ?", [TID, reply.id]);
    }

    // 2) 主题→版块
    await pool.query("UPDATE threads SET forum_id = ? WHERE id = ?", [BOGUS, TID]);
    try {
      expect((await findStructuralAnomalies(pool)).orphanThreads).toBe(1);
    } finally {
      await pool.query("UPDATE threads SET forum_id = ? WHERE id = ?", [thread.forumId, TID]);
    }

    // 3) 门控→帖
    await pool.query("UPDATE post_gates SET post_id = ? WHERE id = ?", [BOGUS, gate.id]);
    try {
      expect((await findStructuralAnomalies(pool)).orphanPostGates).toBe(1);
    } finally {
      await pool.query("UPDATE post_gates SET post_id = ? WHERE id = ?", [gate.postId, gate.id]);
    }

    // 4) 附件→帖：直接插入一条指向不存在帖子的附件，检查后删除
    const ins = await pool.query<any>(
      `INSERT INTO attachments (post_id, file_id, uploader_id, created_at) VALUES (?, 1, 1, NOW())`,
      [BOGUS],
    );
    const attId = (ins[0] as unknown as { insertId: number }).insertId;
    try {
      expect((await findStructuralAnomalies(pool)).orphanAttachments).toBe(1);
    } finally {
      await pool.query("DELETE FROM attachments WHERE id = ?", [attId]);
    }
    expect(await findStructuralAnomalies(pool)).toMatchObject({
      orphanPosts: 0,
      orphanThreads: 0,
      orphanPostGates: 0,
      orphanAttachments: 0,
    });
  });

  it("楼层唯一：唯一索引缺失时，重复楼层的兜底检查能发现", async () => {
    const reply = await one(
      "SELECT id, thread_id AS tid, floor, author_id AS aid, body_md AS body, created_at AS at FROM posts WHERE thread_id = ? AND floor = 2",
      [TID],
    );
    await pool.query("ALTER TABLE posts DROP INDEX uq_posts_thread_floor");
    let dupId = 0;
    try {
      const before = await findStructuralAnomalies(pool);
      expect(before.floorIndexOk).toBe(false);
      expect(before.floorDuplicates).toBe(0);

      // 复制一条回帖，制造 (thread_id, floor) 重复
      const ins = await pool.query<any>(
        `INSERT INTO posts (thread_id, floor, author_id, body_md, created_at) VALUES (?, ?, ?, ?, ?)`,
        [reply.tid, reply.floor, reply.aid, reply.body, reply.at],
      );
      dupId = (ins[0] as unknown as { insertId: number }).insertId;
      const after = await findStructuralAnomalies(pool);
      expect(after.floorDuplicates).toBe(1);
    } finally {
      if (dupId) await pool.query("DELETE FROM posts WHERE id = ?", [dupId]);
      await pool.query(
        "ALTER TABLE posts ADD UNIQUE INDEX uq_posts_thread_floor (thread_id, floor)",
      );
    }
    expect((await findStructuralAnomalies(pool)).floorIndexOk).toBe(true);
  });

  it("首帖指针：指向不存在的帖，或指向非楼层 1 的帖，都会被发现", async () => {
    const tid = TID;
    const orig = await one("SELECT first_post_id AS fp FROM threads WHERE id = ?", [tid]);
    const reply = await one("SELECT id FROM posts WHERE thread_id = ? AND floor = 2", [tid]);
    try {
      await pool.query("UPDATE threads SET first_post_id = ? WHERE id = ?", [999999, tid]);
      expect((await findStructuralAnomalies(pool)).firstPostMissing).toBe(1);

      await pool.query("UPDATE threads SET first_post_id = ? WHERE id = ?", [reply.id, tid]);
      expect((await findStructuralAnomalies(pool)).firstPostMissing).toBe(1);
    } finally {
      await pool.query("UPDATE threads SET first_post_id = ? WHERE id = ?", [orig.fp, tid]);
    }
    expect((await findStructuralAnomalies(pool)).firstPostMissing).toBe(0);
  });

  it("主题与首帖状态：主题状态与首帖不一致时被发现", async () => {
    const tid = TID;
    const orig = await one("SELECT state FROM threads WHERE id = ?", [tid]);
    await pool.query("UPDATE threads SET state = 'hidden' WHERE id = ?", [tid]);
    try {
      expect((await findStructuralAnomalies(pool)).stateMismatch).toBe(1);
    } finally {
      await pool.query("UPDATE threads SET state = ? WHERE id = ?", [orig.state, tid]);
    }
    expect((await findStructuralAnomalies(pool)).stateMismatch).toBe(0);
  });
});
