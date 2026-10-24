/**
 * 数据库集成测试（ROADMAP「集成（DB）」层）：在随机命名的临时库上跑真实 bootstrap / seed，
 * 验证幂等性、系统种子、唯一键语义（scope_id=0 哨兵不再重复）与演示夹具。结束后删库。
 * 需要本机 MySQL（docker/qysub-next）；确实无库的环境用 SKIP_DB_TESTS=1 显式跳过。
 */
import { eq, sql } from "drizzle-orm";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUILTIN_ROLE_KEYS,
  DEFAULT_LIMITS,
  DEFAULT_ROLE_GRANTS,
  PERMISSION_DEFINITIONS,
  ROLE_DEFINITIONS,
} from "./authz-vocab.js";
import { bootstrapDb, PATCHES, seedSystemData } from "./bootstrap.js";
import { createDb, createPool } from "./client.js";
import { newDbConfig } from "./env.js";
import { DEMO, seedDemoData } from "./seed-data.js";
import {
  contentReviews,
  files,
  forums,
  notifications,
  permissions,
  pointAccounts,
  pointLedger,
  postGates,
  posts,
  roleGrants,
  roles,
  siteSettings,
  threads,
  userRoles,
  users,
} from "./schema.js";

const skip = process.env.SKIP_DB_TESTS === "1";
const base = newDbConfig();
const dbName = `funwind_it_${randomBytes(4).toString("hex")}`;
const config = { ...base, database: dbName };
const logs: string[] = [];

const admin = async () =>
  mysql.createConnection({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    charset: "utf8mb4",
  });

describe.skipIf(skip)("bootstrap / seed 集成（临时库）", () => {
  beforeAll(async () => {
    const c = await admin();
    await c.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await c.end();
    await bootstrapDb(config, (m) => logs.push(m));
  });

  afterAll(async () => {
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

  it("bootstrap 建出 v2.1 全部 43 张表，且列级排序规则补丁生效", async () => {
    const pool = createPool(config);
    try {
      const [tables] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> '__drizzle_migrations'`,
        [dbName],
      );
      expect(Number(tables[0]?.n)).toBe(43);
      for (const p of PATCHES) {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
          [dbName, p.table, p.column],
        );
        expect(rows[0]?.c, `${p.table}.${p.column}`).toBe(p.collation);
      }
    } finally {
      await pool.end();
    }
  });

  it("迁移 0002（M6.1）：threads / posts 的作者索引是 (author_id, created_at)，旧的单列索引已删除", async () => {
    const pool = createPool(config);
    try {
      const cols = async (table: string, index: string) => {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT COLUMN_NAME AS c FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`,
          [dbName, table, index],
        );
        return rows.map((r) => String(r.c));
      };
      expect(await cols("threads", "idx_threads_author_created")).toEqual([
        "author_id",
        "created_at",
      ]);
      expect(await cols("posts", "idx_posts_author_created")).toEqual(["author_id", "created_at"]);
      // 对照：旧索引确实被替换而不是并存（并存会白白拖慢每次写入）
      expect(await cols("threads", "idx_threads_author")).toEqual([]);
      expect(await cols("posts", "idx_posts_author")).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("门控 key 区分大小写：A1 与 a1 是两个门控，同名才冲突（复查 B1）", async () => {
    // 应用层的 KEY_RE 允许大小写字母，数据库必须与之同口径；否则 M6 保存含 A1 / a1 的帖子会撞唯一键报 500
    await withTestDb(async (db) => {
      const gate = (key: string) => ({
        postId: 777001,
        gateKey: key,
        conditions: [{ type: "reply" }],
        hiddenMd: "x",
        createdAt: "2026-10-24 00:00:00",
        updatedAt: "2026-10-24 00:00:00",
      });
      await db.insert(postGates).values([gate("A1"), gate("a1"), gate("B-2")]);
      const keys = (await db.select().from(postGates).where(eq(postGates.postId, 777001))).map(
        (g) => g.gateKey,
      );
      expect(keys.sort()).toEqual(["A1", "B-2", "a1"].sort());
      // 完全相同的 key 仍然冲突
      await expect(db.insert(postGates).values(gate("A1"))).rejects.toThrow();
    });
  });

  it("系统种子：角色、权限词汇表、内置角色基线授权、站点设置默认值", async () => {
    await withTestDb(async (db) => {
      expect((await db.select().from(roles)).length).toBe(ROLE_DEFINITIONS.length);
      expect((await db.select().from(permissions)).length).toBe(PERMISSION_DEFINITIONS.length);
      for (const role of BUILTIN_ROLE_KEYS) {
        const rows = await db.select().from(roleGrants).where(eq(roleGrants.roleKey, role));
        expect(rows.map((r) => r.permissionKey).sort()).toEqual(
          [...DEFAULT_ROLE_GRANTS[role]].sort(),
        );
        expect(rows.every((r) => r.scopeId === 0)).toBe(true);
      }
      const keys = (await db.select().from(siteSettings)).map((s) => s.key).sort();
      expect(keys).toEqual(["limits", "points.gate_fee_rate", "points.name", "register.mode"]);
      const stored = (await db.select().from(siteSettings)).find((x) => x.key === "limits");
      expect(stored?.value).toEqual(DEFAULT_LIMITS); // 默认写入限制与代码常量一致（零数据部署开箱可用）
    });
  });

  it("重复 bootstrap 完全幂等：全局授权不再重复（v1 的 NULL 唯一键缺陷）", async () => {
    const before = await withTestDb(async (db) => ({
      grants: (await db.select().from(roleGrants)).length,
      perms: (await db.select().from(permissions)).length,
    }));
    await bootstrapDb(config, (m) => logs.push(m));
    await bootstrapDb(config, (m) => logs.push(m));
    const after = await withTestDb(async (db) => ({
      grants: (await db.select().from(roleGrants)).length,
      perms: (await db.select().from(permissions)).length,
    }));
    expect(after).toEqual(before);
  });

  it("管理员调整过的授权不会被重跑 bootstrap 恢复（基线仅首次写入）", async () => {
    await withTestDb(async (db) => {
      await db
        .delete(roleGrants)
        .where(sql`${roleGrants.roleKey} = 'member' AND ${roleGrants.permissionKey} = 'pm.send'`);
      const summary = await seedSystemData(db);
      expect(summary.grantsInserted).toBe(0);
      const left = await db.select().from(roleGrants).where(eq(roleGrants.roleKey, "member"));
      expect(left.some((g) => g.permissionKey === "pm.send")).toBe(false);
    });
  });

  it("唯一键语义：相同 (角色, 权限点, 作用域) 不能重复写入", async () => {
    await withTestDb(async (db) => {
      await expect(
        db.insert(roleGrants).values({ roleKey: "guest", permissionKey: "site.visit", scopeId: 0 }),
      ).rejects.toThrow();
      await expect(
        db.insert(userRoles).values([
          { userId: 1, roleKey: "admin", scopeId: 0, grantedAt: "2026-01-01 00:00:00" },
          { userId: 1, roleKey: "admin", scopeId: 0, grantedAt: "2026-01-01 00:00:00" },
        ]),
      ).rejects.toThrow();
    });
  });

  it("用户名/邮箱归一化键：区分假名，邮箱大小写合并，无邮箱用户互不冲突", async () => {
    await withTestDb(async (db) => {
      const mk = (id: number, username: string, email: string | null) => ({
        id,
        username,
        usernameKey: username.trim().toLowerCase(),
        email,
        emailKey: email ? email.trim().toLowerCase() : null,
        createdAt: "2026-01-01 00:00:00",
      });
      await db.insert(users).values([
        mk(100001, "さくら", null),
        mk(100002, "サクラ", null), // 平/片假名不碰撞
        mk(100003, "Alice", "A@x.io"),
      ]);
      await expect(db.insert(users).values(mk(100004, "alice", null))).rejects.toThrow(); // 大小写合并
      await expect(db.insert(users).values(mk(100005, "bob", "a@X.io"))).rejects.toThrow(); // 邮箱大小写合并
      await expect(db.insert(users).values(mk(100006, "ｻｸﾗ", null))).resolves.toBeDefined(); // 半角不被 NFKC 合并
    });
  });

  it("演示夹具：连跑两次完全一致，覆盖受限/不上目录版块与门控", async () => {
    await withTestDb(async (db) => {
      await seedDemoData(db);
      const snap = async () => ({
        users: (await db.select().from(users)).length,
        posts: (await db.select().from(posts)).length,
        gates: (await db.select().from(postGates)).length,
        ledger: (await db.select().from(pointLedger)).length,
        accounts: (await db.select().from(pointAccounts)).length,
        grants: (await db.select().from(roleGrants)).length,
        userRoles: (await db.select().from(userRoles)).length,
      });
      const first = await snap();
      await seedDemoData(db);
      expect(await snap()).toEqual(first);

      const [restricted] = await db
        .select()
        .from(forums)
        .where(eq(forums.id, DEMO.restrictedForum));
      expect(restricted?.readPolicy).toBe("restricted");
      expect(restricted?.writePolicy).toBe("restricted");
      const [unlisted] = await db.select().from(forums).where(eq(forums.id, DEMO.unlistedForum));
      expect(unlisted?.isListed).toBe(false);

      // 门控：公开正文只含占位，隐藏正文在 post_gates
      const [gatePost] = await db.select().from(posts).where(eq(posts.id, DEMO.gatePost));
      expect(gatePost?.hasGate).toBe(true);
      const gates = await db.select().from(postGates).where(eq(postGates.postId, DEMO.gatePost));
      expect(gates).toHaveLength(2);
      for (const g of gates) {
        expect(gatePost?.bodyMd ?? "").not.toContain(g.hiddenMd.slice(0, 12));
      }
    });
  });

  it("台账之和 = 账户余额（演示数据对账）", async () => {
    await withTestDb(async (db) => {
      const accounts = await db.select().from(pointAccounts);
      for (const a of accounts) {
        const [sum] = await db
          .select({ s: sql<number>`COALESCE(SUM(${pointLedger.delta}), 0)` })
          .from(pointLedger)
          .where(eq(pointLedger.userId, a.userId));
        expect(Number(sum?.s), `user ${a.userId}`).toBe(a.balance);
      }
    });
  });

  it("v2.1 约束：帖内 gate_key 唯一、文件按 sha256 去重", async () => {
    await withTestDb(async (db) => {
      const gate = (gateKey: string) => ({
        postId: DEMO.gatePost,
        gateKey,
        conditions: [{ type: "login" }],
        hiddenMd: "x",
        createdAt: "2026-10-12 09:00:00",
        updatedAt: "2026-10-12 09:00:00",
      });
      await expect(db.insert(postGates).values(gate("a1"))).rejects.toThrow(); // 夹具已有 a1
      await expect(db.insert(postGates).values(gate("a3"))).resolves.toBeDefined();

      const file = (sha: string) => ({
        sha256: sha.repeat(64).slice(0, 64),
        storageKey: `${sha}${sha}/${sha}${sha}/${sha.repeat(64).slice(0, 64)}.png`,
        createdAt: "2026-10-12 09:00:00",
      });
      await db.insert(files).values(file("a"));
      await expect(db.insert(files).values(file("a"))).rejects.toThrow();
    });
  });

  it("审核夹具：待审核/已驳回主题、驳回记录与通知齐备", async () => {
    await withTestDb(async (db) => {
      const states = new Map(
        (await db.select().from(threads).where(eq(threads.forumId, DEMO.reviewForum))).map((t) => [
          t.id,
          t.state,
        ]),
      );
      expect([...states.values()].sort()).toEqual(["pending", "rejected"]);
      const [review] = await db.select().from(contentReviews);
      expect(review?.decision).toBe("rejected");
      expect((await db.select().from(notifications)).length).toBeGreaterThanOrEqual(2);
    });
  });
});
