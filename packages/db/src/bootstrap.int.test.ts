/**
 * 数据库集成测试（ROADMAP「集成（DB）」层）：在随机命名的临时库上跑真实 bootstrap / seed，
 * 验证幂等性、系统种子、排序规则家族对齐、唯一键语义（scope_id=0 哨兵不再重复）与演示夹具。
 * （qy2010 已于 2026-11-08 移出内置种子——补缺/升级用例随之移除，见 theme-pack-migrations.test。）
 * 需要本机 MySQL（docker/qysub-next）；确实无库的环境用 SKIP_DB_TESTS=1 显式跳过。结束后删库。
 */
import { eq, sql } from "drizzle-orm";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
import { checkAdminApiTokenPermissions } from "./integrity.js";
import { BUILTIN_THEME_PACK_SEEDS } from "./theme-pack-seeds.js";
import { DEMO, seedDemoData } from "./seed-data.js";
import {
  adminApiTokens,
  contentReviews,
  eventOutbox,
  files,
  forums,
  notificationDeliveries,
  notificationReceipts,
  notifications,
  permissions,
  pointAccounts,
  pointLedger,
  postGates,
  posts,
  roleGrants,
  roles,
  siteSettings,
  themePackages,
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
    await c.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
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

  const withPoolDb = async <T>(
    cfg: { host: string; port: number; user: string; password: string; database: string },
    fn: (db: ReturnType<typeof createDb>) => Promise<T>,
  ): Promise<T> => {
    const pool = createPool(cfg);
    try {
      return await fn(createDb(pool));
    } finally {
      await pool.end();
    }
  };

  const verify = () =>
    promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/verify.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        NEW_DB_HOST: config.host,
        NEW_DB_PORT: String(config.port),
        NEW_DB_USER: config.user,
        NEW_DB_PASSWORD: config.password,
        NEW_DB_NAME: config.database,
      },
    });

  /** 按生成的语句分隔符应用版本化 SQL，避免复制表或列定义。 */
  async function applyMigration(pool: ReturnType<typeof createPool>, file: string) {
    const migration = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
  }

  it("bootstrap 建出 schema v2.x 全部 64 张表，且列级排序规则补丁生效", async () => {
    const pool = createPool(config);
    try {
      const [tables] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> '__drizzle_migrations'`,
        [dbName],
      );
      expect(Number(tables[0]?.n)).toBe(64);
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

  it("管理 API 幂等表：零数据安装有复合主键、可用的到期索引和可空响应，无令牌外键，且通过 db:verify", async () => {
    const pool = createPool(config);
    try {
      const [columns] = await pool.query<RowDataPacket[]>(`
        SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manage_api_idempotency'
        ORDER BY ORDINAL_POSITION
      `);
      expect(columns).toEqual([
        { name: "token_id", nullable: "NO" },
        { name: "endpoint", nullable: "NO" },
        { name: "key_hash", nullable: "NO" },
        { name: "request_hash", nullable: "NO" },
        { name: "response", nullable: "YES" },
        { name: "expires_at", nullable: "NO" },
      ]);
      const [indexes] = await pool.query<RowDataPacket[]>(`
        SELECT INDEX_NAME AS name, COLUMN_NAME AS col
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manage_api_idempotency'
          AND IS_VISIBLE = 'YES' AND INDEX_TYPE = 'BTREE'
        ORDER BY INDEX_NAME, SEQ_IN_INDEX
      `);
      expect(indexes.filter((row) => row.name === "PRIMARY").map((row) => row.col)).toEqual([
        "token_id",
        "endpoint",
        "key_hash",
      ]);
      expect(indexes.filter((row) => row.name === "idx_mai_expires").map((row) => row.col)).toEqual(
        ["expires_at"],
      );
      const [foreignKeys] = await pool.query<RowDataPacket[]>(`
        SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'manage_api_idempotency'
      `);
      expect(foreignKeys).toEqual([]);
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT 1 FROM manage_api_idempotency LIMIT 1",
      );
      expect(rows).toEqual([]);
      expect(await verify()).toMatchObject({ stdout: expect.stringContaining("全部通过") });
    } finally {
      await pool.end();
    }
  });

  it("管理令牌：零数据安装的权限列及健康数据通过 db:verify，损坏组合令命令失败", async () => {
    const pool = createPool(config);
    const db = createDb(pool);
    const legacyId = "a".repeat(64);
    const scopedId = "b".repeat(64);
    const baseRow = {
      userId: 1,
      name: "临时测试令牌",
      suffix: "12345678",
      createdAt: "2026-11-01 00:00:00",
      expiresAt: "2026-12-01 00:00:00",
    };
    try {
      expect(await checkAdminApiTokenPermissions(pool)).toEqual({
        profileColumnOk: true,
        snapshotColumnOk: true,
        invalidRows: 0,
      });
      await db.insert(adminApiTokens).values([
        { ...baseRow, id: legacyId },
        {
          ...baseRow,
          id: scopedId,
          permissionProfile: "scoped_v2",
          permissionSnapshot: ["whoami", "contents.detail"],
        },
      ]);
      expect(await verify()).toMatchObject({ stdout: expect.stringContaining("全部通过") });

      const invalidCases: [string, string | null][] = [
        ["unknown_v3", '["whoami"]'],
        ["SCOPED_V2", '["whoami"]'],
        ["legacy_m20_read", "null"],
        ["legacy_m20_read", '["whoami"]'],
        ["scoped_v2", null],
        ["scoped_v2", "null"],
        ["scoped_v2", "[]"],
        ["scoped_v2", '{"id":"whoami"}'],
        ["scoped_v2", JSON.stringify('["whoami"]')],
        ["scoped_v2", '["whoami",11]'],
        ["scoped_v2", '["whoami",""]'],
        ["scoped_v2", '["whoami","whoami"]'],
      ];
      for (const [profile, snapshot] of invalidCases) {
        await pool.execute(
          "UPDATE admin_api_tokens SET permission_profile = ?, permission_snapshot = ? WHERE id = ?",
          [profile, snapshot, scopedId],
        );
        const health = await checkAdminApiTokenPermissions(pool);
        expect(health.invalidRows, `应拒绝 ${profile} + ${snapshot}`).toBe(1);
      }
      await expect(verify()).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("未知权限模型或非法快照组合 1 行"),
      });
    } finally {
      try {
        await pool.execute("DELETE FROM admin_api_tokens WHERE id IN (?, ?)", [legacyId, scopedId]);
      } finally {
        await pool.end();
      }
    }
  });

  it("迁移 0032 保留令牌原值和旧签发兼容性；0033 仅新增空幂等表", async () => {
    const oldName = `${dbName}_m20`;
    const connection = await admin();
    const pool = createPool({ ...base, database: oldName });
    const id = "c".repeat(64);
    const newId = "d".repeat(64);
    /** 旧版签发语句省略两个新增列。 */
    const insertLegacy = (tokenId: string) =>
      pool.execute(
        `INSERT INTO admin_api_tokens
           (id, user_id, name, suffix, created_at, expires_at, last_used_at, last_used_ip, revoked_at)
         VALUES (?, 17, '旧令牌', '87654321', '2026-11-01 10:10:10', '2026-12-01 00:00:00',
                 '2026-11-13 11:12:13', '192.0.2.5', '2026-11-15 12:12:12')`,
        [tokenId],
      );
    try {
      await connection.query(
        `CREATE DATABASE \`${oldName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      await applyMigration(pool, "0031_m20_admin_api_tokens.sql");
      await insertLegacy(id);
      const [[before]] = await pool.execute<RowDataPacket[]>(
        "SELECT * FROM admin_api_tokens WHERE id = ?",
        [id],
      );
      expect(await checkAdminApiTokenPermissions(pool)).toEqual({
        profileColumnOk: false,
        snapshotColumnOk: false,
        invalidRows: null,
      });

      await applyMigration(pool, "0032_m20_2_admin_api_token_permissions.sql");
      await insertLegacy(newId);
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM admin_api_tokens ORDER BY id",
      );
      const expected = {
        ...before,
        permission_profile: "legacy_m20_read",
        permission_snapshot: null,
      };
      expect(rows).toEqual([expected, { ...expected, id: newId }]);
      expect(await checkAdminApiTokenPermissions(pool)).toEqual({
        profileColumnOk: true,
        snapshotColumnOk: true,
        invalidRows: 0,
      });
      const [before0033] = await pool.query<RowDataPacket[]>(`
        SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manage_api_idempotency'
      `);
      expect(before0033).toEqual([]);
      await applyMigration(pool, "0033_m20_2_manage_api_idempotency.sql");
      const [after0033] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM admin_api_tokens ORDER BY id",
      );
      const [idempotencyRows] = await pool.query<RowDataPacket[]>(
        "SELECT 1 FROM manage_api_idempotency LIMIT 1",
      );
      expect(after0033).toEqual(rows);
      expect(idempotencyRows).toEqual([]);

      await pool.query("ALTER TABLE admin_api_tokens ALTER COLUMN permission_profile DROP DEFAULT");
      expect(await checkAdminApiTokenPermissions(pool)).toEqual({
        profileColumnOk: false,
        snapshotColumnOk: true,
        invalidRows: 0,
      });
    } finally {
      try {
        await pool.end();
        await connection.query(`DROP DATABASE IF EXISTS \`${oldName}\``);
      } finally {
        await connection.end();
      }
    }
  });

  it("审核通知零数据安装通过 db:verify，错误默认值和主键顺序会被拦截", async () => {
    await withTestDb(async (db) => {
      expect(await db.select().from(eventOutbox)).toEqual([]);
      expect(await db.select().from(notificationReceipts)).toEqual([]);
      expect(await db.select().from(notificationDeliveries)).toEqual([]);
    });
    expect(await verify()).toMatchObject({
      stdout: expect.stringMatching(
        /✔ outbox:通知投递策略列[\s\S]*✔ outbox:站内通知凭证[\s\S]*✔ outbox:外送通知凭证[\s\S]*全部通过/,
      ),
    });

    const pool = createPool(config);
    try {
      await pool.query(
        "ALTER TABLE event_outbox ALTER COLUMN delivery_policy SET DEFAULT 'moderation_notification_v1'",
      );
      await pool.query(
        "ALTER TABLE notification_receipts DROP PRIMARY KEY, ADD PRIMARY KEY (type, outbox_id, user_id)",
      );
      await pool.query(
        "ALTER TABLE notification_deliveries ALTER COLUMN status SET DEFAULT 'sent'",
      );
      await expect(verify()).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringMatching(
          /✘ outbox:通知投递策略列[\s\S]*✘ outbox:站内通知凭证[\s\S]*✘ outbox:外送通知凭证/,
        ),
      });
    } finally {
      try {
        await pool.query(
          "ALTER TABLE notification_deliveries ALTER COLUMN status SET DEFAULT 'uncertain'",
        );
        await pool.query("ALTER TABLE event_outbox ALTER COLUMN delivery_policy DROP DEFAULT");
        await pool.query(
          "ALTER TABLE notification_receipts DROP PRIMARY KEY, ADD PRIMARY KEY (outbox_id, type, user_id)",
        );
      } finally {
        await pool.end();
      }
    }
  });

  it("迁移 0034/0035 保留已有出箱和站内凭证；外送凭证四列同键不能重新占位", async () => {
    const oldName = `${dbName}_moderation`;
    const connection = await admin();
    const pool = createPool({ ...base, database: oldName });
    const db = createDb(pool);
    const createdAt = "2026-11-18 10:00:00";
    const selectOutbox = () =>
      pool.query<RowDataPacket[]>("SELECT * FROM event_outbox ORDER BY id");
    /** 老版本写入语句不显式设置投递策略。 */
    const insertLegacy = () =>
      pool.execute(
        `INSERT INTO event_outbox
           (event_name, payload, actor_id, source, created_at, dispatched_at, dispatch_error)
         VALUES ('content.reviewed', '{"postId":1}', 7, 'moderation', ?, NULL, '{"attempts":2}'),
                ('content.reviewed', '{"postId":2}', 7, 'moderation', ?, ?, NULL)`,
        [createdAt, createdAt, "2026-11-18 10:01:00"],
      );
    try {
      await connection.query(
        `CREATE DATABASE \`${oldName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      // 0000 提供 0005 所需的积分与权限基础表；0005 的出箱结构直到 0034 才改动。
      await applyMigration(pool, "0000_init_v2_1.sql");
      await applyMigration(pool, "0005_outbox_and_point_rewards.sql");
      await insertLegacy();
      const [before] = await selectOutbox();
      expect(before).toHaveLength(2);
      expect(before[0]).not.toHaveProperty("delivery_policy");

      await applyMigration(pool, "0034_m20_2_moderation_notification_receipts.sql");
      const [after] = await selectOutbox();
      expect(after).toEqual(before.map((row) => ({ ...row, delivery_policy: null })));
      expect(await db.select().from(notificationReceipts)).toEqual([]);

      await insertLegacy();
      await db.insert(eventOutbox).values({
        eventName: "content.reviewed",
        createdAt,
        deliveryPolicy: "moderation_notification_v1",
      });
      const policies = await db
        .select({ policy: eventOutbox.deliveryPolicy })
        .from(eventOutbox)
        .orderBy(eventOutbox.id);
      expect(policies.map((row) => row.policy)).toEqual([
        null,
        null,
        null,
        null,
        "moderation_notification_v1",
      ]);

      const receipt = { outboxId: 1, type: "moderation.approved", userId: 9, createdAt };
      await db
        .insert(notificationReceipts)
        .values([
          receipt,
          { ...receipt, outboxId: 2 },
          { ...receipt, type: "moderation.rejected" },
          { ...receipt, userId: 10 },
        ]);
      await expect(
        db.insert(notificationReceipts).values({ ...receipt, createdAt: "2026-11-18 10:02:00" }),
      ).rejects.toMatchObject({ cause: { code: "ER_DUP_ENTRY" } });
      const receipts = await db.select().from(notificationReceipts);
      expect(receipts).toHaveLength(4);
      expect(receipts).toContainEqual(receipt);

      const [before0035] = await selectOutbox();
      await applyMigration(pool, "0035_m20_2_notification_deliveries.sql");
      const [after0035] = await selectOutbox();
      expect(after0035).toEqual(before0035);
      expect(await db.select().from(notificationReceipts)).toEqual(receipts);
      expect(await db.select().from(notificationDeliveries)).toEqual([]);

      // 两个大整数均超过 32 位；没有对应出箱或账号仍允许保留凭证。
      const delivery = {
        outboxId: 5_000_000_001,
        channel: "email",
        scene: "moderation.approved",
        recipientId: 5_000_000_002,
        createdAt,
      };
      const sent = { ...delivery, status: "sent" as const, finishedAt: "2026-11-18 10:03:00" };
      await db
        .insert(notificationDeliveries)
        .values([
          sent,
          { ...delivery, outboxId: delivery.outboxId + 1 },
          { ...delivery, channel: "push" },
          { ...delivery, scene: "moderation.rejected", status: "failed", finishedAt: createdAt },
          { ...delivery, recipientId: delivery.recipientId + 1 },
        ]);
      await expect(db.insert(notificationDeliveries).values(delivery)).rejects.toMatchObject({
        cause: { code: "ER_DUP_ENTRY" },
      });
      const deliveries = await db.select().from(notificationDeliveries);
      expect(deliveries).toHaveLength(5);
      expect(deliveries).toContainEqual(sent);
      expect(deliveries).toContainEqual({
        ...delivery,
        channel: "push",
        status: "uncertain",
        finishedAt: null,
      });
      await expect(
        pool.execute("UPDATE notification_deliveries SET status = 'SENT' WHERE channel = 'email'"),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    } finally {
      try {
        await pool.end();
        await connection.query(`DROP DATABASE IF EXISTS \`${oldName}\``);
      } finally {
        await connection.end();
      }
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
      expect(keys).toEqual([
        "limits",
        "ops.tasks.seeded", // M14：默认运维任务种子的记账（按任务键首次写入，见 ops-task-seeds.ts）
        "points.gate_fee_rate",
        "points.name",
        "points.reward",
        "punch.reward",
        "register.policy", // M20 清账：种子直接写新键（register.mode 读兼容层已随搬迁移除）
      ]);
      const stored = (await db.select().from(siteSettings)).find((x) => x.key === "limits");
      expect(stored?.value).toEqual(DEFAULT_LIMITS); // 默认写入限制与代码常量一致（零数据部署开箱可用）
    });
  });

  it("M20 清账：词汇表外的越界权限点及其授权随 bootstrap 幂等清除", async () => {
    await withTestDb(async (db) => {
      // 模拟存量库残留：直接插入已从词汇表移除的死键及其授权行
      await db.insert(permissions).values({
        key: "vote.create",
        resource: "vote",
        level: null,
        description: "发起投票（M20 已移除的死键）",
      });
      await db
        .insert(roleGrants)
        .values({ roleKey: "member", permissionKey: "vote.create", scopeId: 0 });
      await db
        .insert(roleGrants)
        .values({ roleKey: "guest", permissionKey: "vote.view", scopeId: 0 });

      const summary = await seedSystemData(db);
      expect(summary.permissionsRemoved).toBeGreaterThanOrEqual(1);

      const permKeys = (await db.select().from(permissions)).map((r) => r.key);
      expect(permKeys).not.toContain("vote.create");
      expect(permKeys).toHaveLength(PERMISSION_DEFINITIONS.length);
      const grantKeys = (await db.select().from(roleGrants)).map((r) => r.permissionKey);
      expect(grantKeys).not.toContain("vote.create");
      expect(grantKeys).not.toContain("vote.view");

      // 幂等：再跑一遍无残留可清
      const again = await seedSystemData(db);
      expect(again.permissionsRemoved).toBe(0);
    });
  });

  it("M20 搬迁：存量库 register.mode → register.policy 翻译写入并删旧键", async () => {
    await withTestDb(async (db) => {
      // 模拟存量库：删掉 bootstrap 刚写的新键，换上旧键 open 模式
      await db.delete(siteSettings).where(eq(siteSettings.key, "register.policy"));
      await db
        .insert(siteSettings)
        .values({ key: "register.mode", value: { mode: "open" }, updatedAt: sql`NOW()` });

      await seedSystemData(db);
      // 旧 open 模式翻译为「开放 + 强制邮箱验证」（与 web 侧旧 policyFromLegacyMode 语义一致）
      const [row] = await db
        .select()
        .from(siteSettings)
        .where(eq(siteSettings.key, "register.policy"));
      expect(row?.value).toEqual({ open: true, invite: false, verifyEmail: true });
      const legacyRows = (await db.select().from(siteSettings)).filter(
        (r) => r.key === "register.mode",
      );
      expect(legacyRows).toHaveLength(0);

      // 幂等：旧键已删，再跑不再搬迁
      const again = await seedSystemData(db);
      expect(again.settingsInserted).toBe(0);
    });
  });

  it("M20 搬迁：invite 模式（默认落点）翻译为邀请制且不放开注册", async () => {
    await withTestDb(async (db) => {
      await db.delete(siteSettings).where(eq(siteSettings.key, "register.policy"));
      await db
        .insert(siteSettings)
        .values({ key: "register.mode", value: { mode: "invite" }, updatedAt: sql`NOW()` });

      await seedSystemData(db);
      const [row] = await db
        .select()
        .from(siteSettings)
        .where(eq(siteSettings.key, "register.policy"));
      expect(row?.value).toEqual({ open: false, invite: true, verifyEmail: false });
      const legacyRows = (await db.select().from(siteSettings)).filter(
        (r) => r.key === "register.mode",
      );
      expect(legacyRows).toHaveLength(0);
    });
  });

  it("重复 bootstrap 完全幂等：全局授权不再重复（v1 的 NULL 唯一键缺陷）", async () => {
    const before = await withTestDb(async (db) => ({
      grants: (await db.select().from(roleGrants)).length,
      perms: (await db.select().from(permissions)).length,
      themePacks: (await db.select().from(themePackages)).length,
    }));
    await bootstrapDb(config, (m) => logs.push(m));
    await bootstrapDb(config, (m) => logs.push(m));
    const after = await withTestDb(async (db) => ({
      grants: (await db.select().from(roleGrants)).length,
      perms: (await db.select().from(permissions)).length,
      themePacks: (await db.select().from(themePackages)).length,
    }));
    expect(after).toEqual(before);
  });

  it("排序规则家族对齐（M13）：0900 旧库一次 bootstrap 全部 CONVERT，三列 _bin 由补丁恢复，重跑不再触发", async () => {
    // 独立临时库，建库时就是 0900_ai_ci（家族切换前的真实形态）：迁移建的表无显式排序规则，继承库默认
    const oldName = `funwind_it_align_${randomBytes(4).toString("hex")}`;
    const oldConfig = { ...base, database: oldName };
    const adminConn = await admin();
    await adminConn.query(
      `CREATE DATABASE \`${oldName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    try {
      const lines: string[] = [];
      await bootstrapDb(oldConfig, (m) => lines.push(m));
      expect(lines.find((l) => l.startsWith("✔ 排序规则家族对齐"))).toContain("0900 → unicode_ci");

      const check = createPool(oldConfig);
      try {
        const [left] = await check.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS n FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = ? AND LOCATE('_0900_', TABLE_COLLATION) > 0`,
          [oldName],
        );
        expect(Number(left[0]?.n)).toBe(0);
        for (const p of PATCHES) {
          const [rows] = await check.query<RowDataPacket[]>(
            `SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [oldName, p.table, p.column],
          );
          expect(String(rows[0]?.c), `${p.table}.${p.column}`).toBe(p.collation);
        }
      } finally {
        await check.end();
      }

      // 全库已无 0900：重跑 bootstrap 的对齐是空操作（不再打日志）
      const again: string[] = [];
      await bootstrapDb(oldConfig, (m) => again.push(m));
      expect(again.find((l) => l.startsWith("✔ 排序规则家族对齐"))).toBeUndefined();

      // 唯一索引重建后核心语义保持：假名两行（さくら/サクラ）在 _bin 键列下不碰撞
      await withPoolDb(oldConfig, async (db) => {
        const mk = (id: number, username: string) => ({
          id,
          username,
          usernameKey: username.trim().toLowerCase(),
          createdAt: "2026-01-01 00:00:00",
        });
        await db.insert(users).values([mk(900001, "さくら"), mk(900002, "サクラ")]);
        await expect(db.insert(users).values(mk(900003, "さくら"))).rejects.toThrow(); // 同名仍冲突
      });
    } finally {
      await adminConn.query(`DROP DATABASE IF EXISTS \`${oldName}\``);
      await adminConn.end();
    }
  });

  it("内置主题包种子：只补缺不覆盖（站长编辑/revision 在重跑后保持）", async () => {
    await withTestDb(async (db) => {
      // 内置包按种子就位且 default 保护位正确
      const packs = await db.select().from(themePackages).orderBy(themePackages.id);
      expect(packs.map((p) => p.id)).toEqual(BUILTIN_THEME_PACK_SEEDS.map((s) => s.id));
      const fallback = packs.find((p) => p.id === "default");
      expect(fallback?.isBuiltin).toBe(true);
      expect(fallback?.enabled).toBe(true);
      // 模拟站长编辑：改名 + revision 提升
      await db
        .update(themePackages)
        .set({ name: "站长改过的默认包", revision: 9 })
        .where(eq(themePackages.id, "default"));
      // 重跑种子：不覆盖人工编辑
      await seedSystemData(db);
      const [after] = await db.select().from(themePackages).where(eq(themePackages.id, "default"));
      expect(after?.name).toBe("站长改过的默认包");
      expect(after?.revision).toBe(9);
    });
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
