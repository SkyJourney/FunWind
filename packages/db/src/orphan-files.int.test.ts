// @vitest-environment node
/**
 * 孤儿文件巡检的真实 MySQL 测试（临时库）。覆盖：无引用且超过宽限期才报告；
 * 附件、头像、徽章图标任一引用即不算孤儿；刚上传（宽限期内）不算；上传记录不算引用。
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDb } from "./bootstrap.js";
import { createDb, createPool } from "./client.js";
import { newDbConfig } from "./env.js";
import { findDiskOrphans, findOrphanFiles } from "./orphan-files.js";
import { attachments, badges, fileUploads, files, posts, userProfiles } from "./schema.js";

const skip = process.env.SKIP_DB_TESTS === "1";
const base = newDbConfig();
const dbName = `funwind_it_${randomBytes(4).toString("hex")}`;
const config = { ...base, database: dbName };
const OLD = "2026-10-01 00:00:00";

const admin = async () =>
  mysql.createConnection({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    charset: "utf8mb4",
  });

describe.skipIf(skip)("孤儿文件巡检（临时库）", () => {
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

  it("只报告无引用且超过 24 小时的文件；各类引用与宽限期内的文件不报告", async () => {
    const pool = createPool(config);
    try {
      const db = createDb(pool);
      const mk = (id: number, created: string) => ({
        id,
        sha256: id.toString(16).padStart(64, "0"),
        storageKey: `aa/aa/${id.toString(16).padStart(64, "0")}.png`,
        sizeBytes: 10 + id,
        mime: "image/png",
        createdAt: created,
      });
      await db.insert(files).values([
        mk(1, OLD), // 孤儿：无引用、超期
        mk(2, OLD), // 有附件行
        mk(3, OLD), // 头像
        mk(4, OLD), // 徽章图标
        mk(5, "2099-01-01 00:00:00"), // 宽限期内（未来时间，等价于刚创建）
      ]);
      await db.insert(attachments).values({
        postId: 1,
        gateId: null,
        fileId: 2,
        uploaderId: 1,
        originalName: "x.png",
        kind: "inline",
        createdAt: OLD,
      });
      await db.insert(userProfiles).values({ userId: 1, avatarFileId: 3 });
      await db.insert(badges).values({ id: 1, key: "b", name: "徽章", iconFileId: 4 });
      // 只在公开正文里被链接（迁移的内联图没有附件行）：不是孤儿
      await db.insert(files).values(mk(6, OLD));
      await db.insert(posts).values({
        id: 1,
        threadId: 1,
        floor: 1,
        authorId: 1,
        bodyMd: `正文 ![x](/files/${mk(6, OLD).storageKey})`,
        hasGate: false,
        state: "visible",
        createdAt: OLD,
      });
      // 上传记录不算引用：文件 1 有一条上传记录，仍是孤儿
      await db.insert(fileUploads).values({ userId: 1, fileId: 1, sizeBytes: 11, createdAt: OLD });
      // 只在个人签名里被链接（签名会被渲染，属于公开文本）：不是孤儿
      await db.insert(files).values(mk(8, OLD));
      await db
        .update(userProfiles)
        .set({ signatureMd: `签名 ![s](/files/${mk(8, OLD).storageKey})` })
        .where(eq(userProfiles.userId, 1));
      // 去重命中：文件 7 创建于很久以前，但刚被别人重新上传（files.created_at 不更新）→ 宽限期内，不是孤儿
      await db.insert(files).values(mk(7, OLD));
      await db
        .insert(fileUploads)
        .values({ userId: 2, fileId: 7, sizeBytes: 17, createdAt: sql`NOW()` });

      const orphans = await findOrphanFiles(pool);
      expect(orphans.map((o) => o.id)).toEqual([1]); // 文件 6 只在正文中出现，不算孤儿
      expect(orphans[0]).toMatchObject({
        id: 1,
        sizeBytes: 11,
        storageKey: expect.stringMatching(/\.png$/),
      });
    } finally {
      await pool.end();
    }
  });
  it("磁盘孤儿：只报告「磁盘有、库里没有、超过宽限期」的内容寻址文件；临时目录、缩略图缓存、近期文件与非法文件名不报告", async () => {
    const storageDir = await mkdtemp(path.join(os.tmpdir(), "gc-files-"));
    const pool = createPool(config);
    try {
      const old = new Date(Date.now() - 3 * 24 * 3600_000);
      const hex = (n: number) => n.toString(16).padStart(64, "0");
      const put = async (rel: string, when: Date) => {
        const abs = path.join(storageDir, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, "x");
        await utimes(abs, when, when);
      };
      // 库里已有的文件（第一个用例插入的 aa/aa/…01.png）：不是孤儿
      await put(`aa/aa/${hex(1)}.png`, old);
      // 磁盘孤儿：超期、库里没有
      await put(`cc/dd/${hex(0xabc)}.png`, old);
      // 近期文件（写入后尚未保存）：宽限期内，不报告
      await put(`cc/dd/${hex(0xdef)}.png`, new Date());
      // 写入中的临时文件与缩略图缓存：不遍历
      await put(`.tmp/${hex(0x111)}.png`, old);
      await put(`.cache/thumbs/${hex(0x222)}-320.png`, old);
      // 非法文件名：不报告
      await put("cc/dd/not-a-hash.png", old);

      const orphans = await findDiskOrphans(storageDir, pool);
      expect(orphans.map((o) => o.storageKey)).toEqual([`cc/dd/${hex(0xabc)}.png`]);
      expect(orphans[0]).toMatchObject({ sizeBytes: 1 });
    } finally {
      await pool.end();
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
