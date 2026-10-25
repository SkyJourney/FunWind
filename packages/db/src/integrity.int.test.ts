/**
 * 完整性检查的集成测试（临时库）：造出三类附件↔门控异常，断言检查能逐类发现，干净数据为零。
 * SKIP_DB_TESTS=1 时跳过（与其余 *.int.test.ts 一致）。
 */
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDb } from "./bootstrap.js";
import { createDb, createPool } from "./client.js";
import { newDbConfig } from "./env.js";
import { findAttachmentGateAnomalies, findInlineAttachmentAnomalies } from "./integrity.js";
import { attachments, fileUploads, files, postGates, posts } from "./schema.js";

const skip = process.env.SKIP_DB_TESTS === "1";
const base = newDbConfig();
const dbName = `funwind_it_${randomBytes(4).toString("hex")}`;
const config = { ...base, database: dbName };
const T = "2026-10-24 12:00:00";

const admin = async () =>
  mysql.createConnection({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    charset: "utf8mb4",
  });

describe.skipIf(skip)("附件↔门控完整性检查（临时库）", () => {
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

  it("干净数据为零；三类异常各被发现一次", async () => {
    const pool = createPool(config);
    try {
      const db = createDb(pool);
      expect(await findAttachmentGateAnomalies(pool)).toEqual({
        dangling: 0,
        crossPost: 0,
        onUngatedPost: 0,
      });

      // 帖 1 有门控（has_gate=1），帖 2 有门控，帖 3 无门控
      await db.insert(posts).values([
        { id: 1, threadId: 1, floor: 1, authorId: 1, hasGate: true, createdAt: T },
        { id: 2, threadId: 2, floor: 1, authorId: 1, hasGate: true, createdAt: T },
        { id: 3, threadId: 3, floor: 1, authorId: 1, hasGate: false, createdAt: T },
      ]);
      await db.insert(postGates).values([
        {
          id: 10,
          postId: 1,
          gateKey: "a1",
          conditions: [],
          hiddenMd: "x",
          createdAt: T,
          updatedAt: T,
        },
        {
          id: 20,
          postId: 2,
          gateKey: "a1",
          conditions: [],
          hiddenMd: "y",
          createdAt: T,
          updatedAt: T,
        },
      ]);
      await db
        .insert(files)
        .values({ id: 1, sha256: "a".repeat(64), storageKey: "aa/aa/f.bin", createdAt: T });
      const att = (postId: number, gateId: number | null) => ({
        postId,
        gateId,
        fileId: 1,
        uploaderId: 1,
        createdAt: T,
      });

      // 合法：公开、挂在本帖门控
      await db.insert(attachments).values([att(1, null), att(1, 10)]);
      expect(await findAttachmentGateAnomalies(pool)).toEqual({
        dangling: 0,
        crossPost: 0,
        onUngatedPost: 0,
      });

      await db.insert(attachments).values(att(1, 999)); // 悬空
      await db.insert(attachments).values(att(1, 20)); // 门控属于帖 2
      await db.insert(attachments).values(att(3, 10)); // 帖 3 无门控，且门控属于帖 1
      expect(await findAttachmentGateAnomalies(pool)).toEqual({
        dangling: 1,
        crossPost: 2, // 帖 1→门控 20、帖 3→门控 10
        onUngatedPost: 1, // 帖 3
      });
    } finally {
      await pool.end();
    }
  });
  it("内联图片：门控跨帖、文件缺失、上传记录悬空各被发现；download 行不计入", async () => {
    const pool = createPool(config);
    try {
      const db = createDb(pool);
      // 前一个用例已建好：帖 1 的门控 10、帖 2 的门控 20，文件 1
      // 合法的内联行：挂在本帖门控 10
      await db.insert(attachments).values({
        postId: 1,
        gateId: 10,
        fileId: 1,
        uploaderId: 1,
        kind: "inline",
        createdAt: T,
      });
      expect(await findInlineAttachmentAnomalies(pool)).toEqual({
        gateMismatch: 0,
        missingFile: 0,
        uploadOrphan: 0,
      });

      // 异常一：内联行挂到帖 2 的门控 20；异常二：内联行引用不存在的文件 999
      await db.insert(attachments).values([
        { postId: 1, gateId: 20, fileId: 1, uploaderId: 1, kind: "inline", createdAt: T },
        { postId: 1, gateId: null, fileId: 999, uploaderId: 1, kind: "inline", createdAt: T },
        // 同样的跨帖门控，但是 download 行：门控归属由附件门控检查守住，不计入这里
        { postId: 1, gateId: 20, fileId: 1, uploaderId: 1, createdAt: T },
        // 下载行引用不存在的文件：帖末列表会静默丢掉它，计入文件缺失（异常四）
        { postId: 1, gateId: null, fileId: 998, uploaderId: 1, createdAt: T },
      ]);
      // 异常三：上传记录引用不存在的文件
      await db.insert(fileUploads).values({ userId: 1, fileId: 999, sizeBytes: 1, createdAt: T });

      expect(await findInlineAttachmentAnomalies(pool)).toEqual({
        gateMismatch: 1,
        missingFile: 2,
        uploadOrphan: 1,
      });
    } finally {
      await pool.end();
    }
  });
});
