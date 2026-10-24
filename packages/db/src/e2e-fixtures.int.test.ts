/**
 * E2E 专用夹具的集成测试（临时库 + 临时存储目录）：
 * 夹具是「自包含 E2E」的地基——它造得对不对、能不能重复跑，直接决定 CI 上 E2E 是否可信，所以单独把关。
 * SKIP_DB_TESTS=1 时跳过（与 bootstrap.int.test.ts 一致）。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDb } from "./bootstrap.js";
import { createDb, createPool } from "./client.js";
import { newDbConfig } from "./env.js";
import { E2E_FIX, seedE2eFixtures } from "./e2e-fixtures.js";
import { seedDemoData } from "./seed-data.js";
import {
  attachments,
  files,
  forums,
  pollOptions,
  roleGrants,
  threads,
  userProfiles,
  users,
} from "./schema.js";

const skip = process.env.SKIP_DB_TESTS === "1";
const base = newDbConfig();
const dbName = `funwind_it_${randomBytes(4).toString("hex")}`;
const config = { ...base, database: dbName };
const storageDir = mkdtempSync(join(tmpdir(), "funwind-e2e-fixtures-"));
const savedStorageDir = process.env.STORAGE_DIR;

const admin = async () =>
  mysql.createConnection({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    charset: "utf8mb4",
  });

describe.skipIf(skip)("E2E 夹具集成（临时库）", () => {
  beforeAll(async () => {
    process.env.STORAGE_DIR = storageDir; // 夹具文件落到临时目录，不污染仓库的 storage/
    const c = await admin();
    await c.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await c.end();
    await bootstrapDb(config, () => {});
  });

  afterAll(async () => {
    if (savedStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = savedStorageDir;
    rmSync(storageDir, { recursive: true, force: true });
    const c = await admin();
    await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await c.end();
  });

  const withTestDb = async <T>(fn: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> => {
    const pool = createPool(config);
    try {
      return await fn(createDb(pool));
    } finally {
      await pool.end();
    }
  };

  it("连跑两次完全一致（幂等），且各场景都造出来了", async () => {
    await withTestDb(async (db) => {
      await seedDemoData(db);
      await seedE2eFixtures(db);
      const snap = async () => ({
        threads: (await db.select().from(threads)).length,
        files: (await db.select().from(files)).length,
        attachments: (await db.select().from(attachments)).length,
        options: (await db.select().from(pollOptions)).length,
      });
      const first = await snap();
      await seedE2eFixtures(db);
      expect(await snap()).toEqual(first);

      const F = E2E_FIX;
      // 水区：60 个普通主题 + 1 个版块置顶
      const water = await db.select().from(threads).where(eq(threads.forumId, F.water));
      expect(water.filter((t) => t.pinLevel === 0)).toHaveLength(F.waterCount);
      expect(water.filter((t) => t.pinLevel === 1)).toHaveLength(1);
      // 全站置顶 3 个，且不在水区（跨版块置顶才有意义）
      const globalPins = await db.select().from(threads).where(eq(threads.pinLevel, 3));
      expect(globalPins.map((t) => t.id).sort()).toEqual([...F.thread.globalPins].sort());
      expect(globalPins.every((t) => t.forumId === F.anime)).toBe(true);
      // 投票帖有 poll_options；已删除主题确实是 deleted
      expect(await db.select().from(pollOptions)).toHaveLength(2);
      const [gone] = await db.select().from(threads).where(eq(threads.id, F.thread.deletedState));
      expect(gone?.state).toBe("deleted");
      // 已注销占位账号：state=deleted，且不带邮箱与口令
      const [ph] = await db.select().from(users).where(eq(users.id, F.placeholderUser));
      expect(ph).toMatchObject({ state: "deleted", email: null, passwordHash: null });
      // 站务组：受限，且没有任何角色被授权（只有 admin 能读）
      const [staff] = await db.select().from(forums).where(eq(forums.id, F.staff));
      expect(staff?.readPolicy).toBe("restricted");
      const grants = await db
        .select()
        .from(roleGrants)
        .where(and(eq(roleGrants.scopeId, F.staff)));
      expect(grants).toHaveLength(0);
    });
  });

  it("文件真实落盘、哈希与登记一致；头像与附件指向这些文件", async () => {
    await withTestDb(async (db) => {
      const rows = await db.select().from(files);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const f of rows) {
        const p = join(storageDir, f.storageKey);
        expect(existsSync(p), f.storageKey).toBe(true);
        expect(createHash("sha256").update(readFileSync(p)).digest("hex")).toBe(f.sha256);
      }
      const [profile] = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, E2E_FIX.alice));
      const png = rows.find((f) => f.mime === "image/png");
      expect(profile?.avatarFileId).toBe(png?.id);
      const atts = await db.select().from(attachments);
      expect(atts).toHaveLength(2);
      expect(
        atts.every((a) => rows.some((f) => f.id === a.fileId && f.mime === "text/plain")),
      ).toBe(true);
    });
  });
});
