/**
 * 运维任务配置表（M14 Step 2）：真实临时库上的双端契约测试 + 默认任务种子语义。
 *
 * 契约测试直接解析管线侧 services/backup/tests/contract.py 的建表 DDL（管线测试按它自建配置表），
 * 与 drizzle 迁移建出的真实表逐列（名称/类型/可空/顺序）与逐索引比对——任一端改列而另一端没跟上，
 * 这里会变红（管线以 Python 读这两张表，类型系统无法跨语言守护）。
 * 需要本机 MySQL（docker/qysub-next）；确实无库的环境用 SKIP_DB_TESTS=1 显式跳过。结束后删库。
 */
import { eq, inArray, sql } from "drizzle-orm";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapDb, seedSystemData } from "./bootstrap.js";
import { createDb, createPool } from "./client.js";
import { newDbConfig } from "./env.js";
import {
  LEGACY_BACKUP_POLICY_KEY,
  legacyKeep,
  OPS_SEEDED_SETTING_KEY,
  OPS_TASK_SEEDS,
} from "./ops-task-seeds.js";
import { opsTasks, opsTriggers, siteSettings } from "./schema.js";

const skip = process.env.SKIP_DB_TESTS === "1";
const base = newDbConfig();
const dbName = `funwind_ops_it_${randomBytes(4).toString("hex")}`;
const config = { ...base, database: dbName };
const CONTRACT_FILE = join(import.meta.dirname, "../../../services/backup/tests/contract.py");

interface ContractColumn {
  name: string;
  type: string;
  nullable: boolean;
}
interface ContractIndex {
  name: string;
  unique: boolean;
  columns: string;
}

/** 解析 contract.py 里一段 `NAME = """CREATE TABLE …"""` DDL 为列与索引清单 */
function parseContractDdl(source: string, constName: string) {
  const block = source.match(new RegExp(`${constName} = """([\\s\\S]*?)"""`))?.[1];
  if (!block) throw new Error(`contract.py 中找不到 ${constName}`);
  const columns: ContractColumn[] = [];
  const indexes: ContractIndex[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line || /^CREATE TABLE/i.test(line) || line.startsWith(")")) continue;
    const index = line.match(/^(UNIQUE KEY|INDEX) (\w+) \(([^)]+)\)$/i);
    if (index) {
      indexes.push({
        name: index[2]!,
        unique: /^UNIQUE/i.test(index[1]!),
        columns: index[3]!.replace(/\s+/g, ""),
      });
      continue;
    }
    const column = line.match(/^(\w+) (.+)$/);
    if (!column) throw new Error(`无法解析契约行：${line}`);
    const rest = column[2]!;
    const type = rest
      .split(/ (?:NOT NULL|NULL|AUTO_INCREMENT|DEFAULT|PRIMARY KEY)\b/i)[0]!
      .trim()
      .toLowerCase()
      .replace(/^boolean$/, "tinyint(1)");
    columns.push({ name: column[1]!, type, nullable: !/NOT NULL|PRIMARY KEY/i.test(rest) });
  }
  return { columns, indexes };
}

const admin = async () =>
  mysql.createConnection({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    charset: "utf8mb4",
  });

describe.skipIf(skip)("运维任务配置表（临时库）", () => {
  const pool = () => createPool(config);
  let shared: ReturnType<typeof createPool>;
  const db = () => createDb(shared);

  beforeAll(async () => {
    const c = await admin();
    await c.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await c.end();
    await bootstrapDb(config, () => {});
    shared = pool();
  });

  afterAll(async () => {
    await shared?.end();
    const c = await admin();
    await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await c.end();
  });

  describe("双端契约：drizzle 建出的表 ⇄ 管线 tests/contract.py", () => {
    const source = readFileSync(CONTRACT_FILE, "utf8");

    it.each([
      ["ops_tasks", "OPS_TASKS_DDL"],
      ["ops_triggers", "OPS_TRIGGERS_DDL"],
    ])("%s 逐列与逐索引一致", async (table, constName) => {
      const contract = parseContractDdl(source, constName);
      const [columns] = await shared.query<RowDataPacket[]>(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [dbName, table],
      );
      expect(
        columns.map((c) => ({
          name: String(c.name),
          type: String(c.type).toLowerCase(),
          nullable: c.nullable === "YES",
        })),
      ).toEqual(contract.columns);

      const [indexes] = await shared.query<RowDataPacket[]>(
        `SELECT INDEX_NAME AS name, MAX(NON_UNIQUE) = 0 AS isUnique,
                GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME <> 'PRIMARY'
         GROUP BY INDEX_NAME ORDER BY INDEX_NAME`,
        [dbName, table],
      );
      expect(
        indexes.map((i) => ({
          name: String(i.name),
          unique: Number(i.isUnique) === 1,
          columns: String(i.cols),
        })),
      ).toEqual([...contract.indexes].sort((a, b) => a.name.localeCompare(b.name)));
    });

    it("契约解析器自检：能读出两张表的全部列（防止正则失配后两边同时为空而假绿）", () => {
      expect(parseContractDdl(source, "OPS_TASKS_DDL").columns.map((c) => c.name)).toEqual([
        "id",
        "task_key",
        "name",
        "executor",
        "params",
        "enabled",
        "revision",
        "created_at",
        "updated_at",
      ]);
      expect(parseContractDdl(source, "OPS_TRIGGERS_DDL").columns).toHaveLength(8);
    });
  });

  describe("默认任务种子（按任务键首次写入）", () => {
    const SEED_KEYS = OPS_TASK_SEEDS.map((s) => s.taskKey);

    async function resetOps() {
      await db().delete(opsTriggers);
      await db().delete(opsTasks);
      await db()
        .delete(siteSettings)
        .where(inArray(siteSettings.key, [OPS_SEEDED_SETTING_KEY, LEGACY_BACKUP_POLICY_KEY]));
    }

    async function snapshotOps() {
      const tasks = await db()
        .select({ key: opsTasks.taskKey, params: opsTasks.params, revision: opsTasks.revision })
        .from(opsTasks)
        .orderBy(opsTasks.taskKey);
      const triggers = await db()
        .select({ key: opsTriggers.taskKey, kind: opsTriggers.kind, expr: opsTriggers.expr })
        .from(opsTriggers)
        .orderBy(opsTriggers.taskKey, opsTriggers.kind);
      const [marker] = await db()
        .select({ value: siteSettings.value })
        .from(siteSettings)
        .where(eq(siteSettings.key, OPS_SEEDED_SETTING_KEY));
      return { tasks, triggers, seeded: marker?.value };
    }

    beforeEach(resetOps);

    it("空表首次写入：两条备份任务 + 各自 cron 与手动触发器，并记账", async () => {
      const summary = await seedSystemData(db());
      expect(summary.opsTasksSeeded).toBe(2);
      const state = await snapshotOps();
      expect(state.tasks).toEqual([
        { key: "backup.db", params: { keep: 14 }, revision: 1 },
        { key: "backup.storage", params: { keep: 7 }, revision: 1 },
      ]);
      expect(state.triggers).toEqual([
        { key: "backup.db", kind: "cron", expr: "10 3 * * *" },
        { key: "backup.db", kind: "manual", expr: null },
        { key: "backup.storage", kind: "cron", expr: "40 3 * * *" },
        { key: "backup.storage", kind: "manual", expr: null },
      ]);
      expect(state.seeded).toEqual(SEED_KEYS);
    });

    it("重跑幂等：第二次不写任何行", async () => {
      await seedSystemData(db());
      const before = await snapshotOps();
      expect((await seedSystemData(db())).opsTasksSeeded).toBe(0);
      expect(await snapshotOps()).toEqual(before);
    });

    it("站长改过的参数与删掉的触发器，重跑不恢复", async () => {
      await seedSystemData(db());
      await db()
        .update(opsTasks)
        .set({ params: { keep: 3 }, revision: 2 })
        .where(eq(opsTasks.taskKey, "backup.db"));
      await db()
        .delete(opsTriggers)
        .where(sql`${opsTriggers.taskKey} = 'backup.db' AND ${opsTriggers.kind} = 'cron'`);
      await seedSystemData(db());
      const state = await snapshotOps();
      expect(state.tasks[0]).toEqual({ key: "backup.db", params: { keep: 3 }, revision: 2 });
      expect(state.triggers.filter((t) => t.key === "backup.db")).toEqual([
        { key: "backup.db", kind: "manual", expr: null },
      ]);
    });

    it("删掉的默认任务不复活（记账生效）", async () => {
      await seedSystemData(db());
      await db().delete(opsTriggers).where(eq(opsTriggers.taskKey, "backup.storage"));
      await db().delete(opsTasks).where(eq(opsTasks.taskKey, "backup.storage"));
      expect((await seedSystemData(db())).opsTasksSeeded).toBe(0);
      expect((await snapshotOps()).tasks.map((t) => t.key)).toEqual(["backup.db"]);
    });

    it("v1 保留策略迁入任务参数（升级路径）", async () => {
      await db()
        .insert(siteSettings)
        .values({
          key: LEGACY_BACKUP_POLICY_KEY,
          value: { keepDb: 5, keepStorage: 3 },
          updatedAt: sql`NOW()`,
        });
      await seedSystemData(db());
      expect((await snapshotOps()).tasks.map((t) => t.params)).toEqual([{ keep: 5 }, { keep: 3 }]);
    });

    it("站长先手工建了同键任务：只记账，不覆盖、不追加触发器", async () => {
      await db()
        .insert(opsTasks)
        .values({
          taskKey: "backup.db",
          name: "自建",
          executor: "backup.db",
          params: { keep: 30 },
          enabled: false,
          revision: 4,
          createdAt: sql`NOW()`,
          updatedAt: sql`NOW()`,
        });
      expect((await seedSystemData(db())).opsTasksSeeded).toBe(1); // 只写入了 backup.storage
      const state = await snapshotOps();
      expect(state.tasks[0]).toEqual({ key: "backup.db", params: { keep: 30 }, revision: 4 });
      expect(state.triggers.filter((t) => t.key === "backup.db")).toEqual([]);
      expect(state.seeded).toEqual(SEED_KEYS);
    });
  });
});

describe("legacyKeep：v1 保留策略取值", () => {
  it.each([
    [{ keepDb: 5 }, 5],
    [{ keepDb: 90 }, 90],
    [{ keepDb: 0 }, 14],
    [{ keepDb: 91 }, 14],
    [{ keepDb: 7.5 }, 14],
    [{ keepDb: "7" }, 14],
    [{}, 14],
    [null, 14],
    ["x", 14],
  ])("%j → %i", (policy, expected) => {
    expect(legacyKeep(policy, "keepDb", 14)).toBe(expected);
  });
});
