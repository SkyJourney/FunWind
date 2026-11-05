/**
 * 内置主题包升级原语的集成测试（M11.6 Step 2）：在随机命名的临时库上跑真实 MySQL，结束后删库。
 * 需要本机 MySQL（docker/qysub-next）；确实无库的环境用 SKIP_DB_TESTS=1 显式跳过。
 */
import { eq, sql } from "drizzle-orm";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDb } from "./bootstrap.js";
import { createDb, createPool } from "./client.js";
import { newDbConfig } from "./env.js";
import { themePackages } from "./schema.js";
import { BUILTIN_THEME_PACK_SEEDS } from "./theme-pack-seeds.js";
import { backfillMissingSections, resetToBuiltin, swapIfUnchanged } from "./theme-pack-upgrade.js";

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

describe.skipIf(skip)("内置主题包升级原语集成（临时库）", () => {
  const pool = createPool(config);
  const db = createDb(pool);
  let seq = 0;
  /** 插入测试行时写入的固定旧时间戳：写库路径必须把它刷新，跳过路径必须保持不变 */
  const OLD_STAMP = "2000-01-01 00:00:00";

  beforeAll(async () => {
    const c = await admin();
    await c.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await c.end();
    await bootstrapDb(config, () => {});
  });

  afterAll(async () => {
    await pool.end();
    const c = await admin();
    await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await c.end();
  });

  /** 插入一行测试包（每次一个新 id，用例之间互不影响） */
  async function insertPack(definition: Record<string, unknown>, isBuiltin = false) {
    const id = `up-${++seq}`;
    await db.insert(themePackages).values({
      id,
      name: id,
      description: "",
      schemaVersion: 1,
      definition,
      assets: [],
      enabled: false,
      isBuiltin,
      revision: 1,
      createdAt: sql`${OLD_STAMP}`,
      updatedAt: sql`${OLD_STAMP}`,
    });
    return id;
  }

  async function read(id: string) {
    const [row] = await db
      .select({ definition: themePackages.definition, revision: themePackages.revision })
      .from(themePackages)
      .where(eq(themePackages.id, id));
    if (!row) throw new Error(`测试包不存在：${id}`);
    return { definition: row.definition as Record<string, unknown>, revision: row.revision };
  }

  /** 某个 JSON 路径上值的 MySQL 类型（OBJECT / STRING / ...），用来证明写进去的不是字符串标量 */
  async function jsonTypeAt(id: string, path: string) {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT JSON_TYPE(JSON_EXTRACT(definition, ?)) AS t FROM theme_packages WHERE id = ?",
      [path, id],
    );
    return rows[0]?.t as string | undefined;
  }

  async function stampOf(id: string) {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT updated_at AS s FROM theme_packages WHERE id = ?",
      [id],
    );
    return String(rows[0]?.s);
  }

  const TOKENS = { light: { colors: { primary: "#147ba9", "card-foreground": "#33332f" } } };

  describe("backfillMissingSections", () => {
    it("缺失的段被补成 JSON 对象（不是字符串标量），并递增 revision", async () => {
      const id = await insertPack({ surfaces: {} });
      expect(await backfillMissingSections(db, id, { tokens: TOKENS })).toBe(1);
      const row = await read(id);
      expect(row.definition).toEqual({ surfaces: {}, tokens: TOKENS });
      expect(row.revision).toBe(2);
      expect(await jsonTypeAt(id, '$."tokens"')).toBe("OBJECT");
      expect(await stampOf(id)).not.toBe(OLD_STAMP);
    });

    it("已有的段不覆盖；全部段都已存在时不写库，revision 不变", async () => {
      const mine = { light: { colors: { primary: "#000000" } } };
      const id = await insertPack({ surfaces: {}, tokens: mine });
      expect(await backfillMissingSections(db, id, { tokens: TOKENS })).toBe(0);
      const row = await read(id);
      expect(row.definition.tokens).toEqual(mine);
      expect(row.revision).toBe(1);
      expect(await stampOf(id)).toBe(OLD_STAMP);
    });

    it("多个段里只补缺失的那些，已有的保持原样", async () => {
      const pwa = { themeColor: "#111111", backgroundColor: "#222222" };
      const id = await insertPack({ surfaces: {}, pwa });
      const other = { themeColor: "#999999", backgroundColor: "#888888" };
      expect(await backfillMissingSections(db, id, { pwa: other, tokens: TOKENS })).toBe(1);
      const row = await read(id);
      expect(row.definition.pwa).toEqual(pwa);
      expect(row.definition.tokens).toEqual(TOKENS);
      expect(row.revision).toBe(2);
    });

    it("重复执行是幂等的：第二次返回 0，revision 不再增加", async () => {
      const id = await insertPack({ surfaces: {} });
      expect(await backfillMissingSections(db, id, { tokens: TOKENS })).toBe(1);
      expect(await backfillMissingSections(db, id, { tokens: TOKENS })).toBe(0);
      expect((await read(id)).revision).toBe(2);
    });

    it("包不存在或没有要补的段时返回 0", async () => {
      expect(await backfillMissingSections(db, "no-such-pack", { tokens: TOKENS })).toBe(0);
      const id = await insertPack({ surfaces: {} });
      expect(await backfillMissingSections(db, id, {})).toBe(0);
      expect((await read(id)).revision).toBe(1);
    });

    it("非法段名直接报错且不写库", async () => {
      const id = await insertPack({ surfaces: {} });
      for (const name of ["", "to kens", "tokens'", "$.x", "a.b", "1a", 'a"b']) {
        await expect(backfillMissingSections(db, id, { [name]: 1 })).rejects.toThrow(TypeError);
      }
      expect(await read(id)).toEqual({ definition: { surfaces: {} }, revision: 1 });
    });

    it("值里的引号、反斜杠与非 ASCII 字符原样往返", async () => {
      const id = await insertPack({ surfaces: {} });
      const tricky = { label: `a"b\\c'd 中文 \u{1F600}`, n: 1 };
      expect(await backfillMissingSections(db, id, { extra: tricky })).toBe(1);
      expect((await read(id)).definition.extra).toEqual(tricky);
    });

    it("无法序列化的值直接报错", async () => {
      const id = await insertPack({ surfaces: {} });
      await expect(backfillMissingSections(db, id, { extra: undefined })).rejects.toThrow(
        TypeError,
      );
    });
  });

  describe("swapIfUnchanged", () => {
    const COLORS = ["tokens", "light", "colors"];

    it("值仍等于旧值时替换并递增 revision，其余字段不动", async () => {
      const id = await insertPack({
        surfaces: {},
        tokens: { light: { colors: { primary: "#147ba9", ring: "#147ba9" } } },
      });
      expect(await swapIfUnchanged(db, id, [...COLORS, "primary"], "#147ba9", "#116a92")).toBe(1);
      const row = await read(id);
      expect(row.definition.tokens).toEqual({
        light: { colors: { primary: "#116a92", ring: "#147ba9" } },
      });
      expect(row.revision).toBe(2);
      expect(await stampOf(id)).not.toBe(OLD_STAMP);
    });

    it("站长改过的值跳过：不替换、revision 不变", async () => {
      const id = await insertPack({
        surfaces: {},
        tokens: { light: { colors: { primary: "#abcdef" } } },
      });
      expect(await swapIfUnchanged(db, id, [...COLORS, "primary"], "#147ba9", "#116a92")).toBe(0);
      const row = await read(id);
      expect(row.definition.tokens).toEqual({ light: { colors: { primary: "#abcdef" } } });
      expect(row.revision).toBe(1);
      expect(await stampOf(id)).toBe(OLD_STAMP);
    });

    it("路径不存在时跳过，不会凭空创建", async () => {
      const id = await insertPack({ surfaces: {} });
      expect(await swapIfUnchanged(db, id, [...COLORS, "primary"], "#147ba9", "#116a92")).toBe(0);
      expect(await read(id)).toEqual({ definition: { surfaces: {} }, revision: 1 });
    });

    it("键名带连字符、值为数字与布尔时也能比较并替换", async () => {
      const id = await insertPack({
        surfaces: {},
        tokens: {
          light: {
            colors: { "card-foreground": "#33332f" },
            band: { width: 8.5, mask: false },
          },
        },
      });
      expect(
        await swapIfUnchanged(db, id, [...COLORS, "card-foreground"], "#33332f", "#000000"),
      ).toBe(1);
      expect(await swapIfUnchanged(db, id, ["tokens", "light", "band", "width"], 8.5, 7)).toBe(1);
      expect(await swapIfUnchanged(db, id, ["tokens", "light", "band", "mask"], false, true)).toBe(
        1,
      );
      expect((await read(id)).definition.tokens).toEqual({
        light: { colors: { "card-foreground": "#000000" }, band: { width: 7, mask: true } },
      });
    });

    it("非法路径段直接报错且不写库", async () => {
      const id = await insertPack({
        surfaces: {},
        tokens: { light: { colors: { primary: "#1" } } },
      });
      const bad: string[][] = [[], [""], ["tokens", "a.b"], ["tokens", "x'"], ['tokens", "y']];
      for (const path of bad) {
        await expect(swapIfUnchanged(db, id, path, "#1", "#2")).rejects.toThrow(TypeError);
      }
      expect((await read(id)).revision).toBe(1);
    });

    it("旧值里夹带 SQL 也只是一个不匹配的值：返回 0，表仍然完好", async () => {
      const id = await insertPack({
        surfaces: {},
        tokens: { light: { colors: { primary: "#1" } } },
      });
      const evil = "'; DROP TABLE theme_packages; --";
      expect(await swapIfUnchanged(db, id, [...COLORS, "primary"], evil, "#2")).toBe(0);
      expect((await read(id)).revision).toBe(1);
    });
  });

  describe("resetToBuiltin", () => {
    it("每个内置种子被改坏后都能恢复为种子定义并递增 revision", async () => {
      for (const seed of BUILTIN_THEME_PACK_SEEDS) {
        await db
          .update(themePackages)
          .set({ definition: { surfaces: {}, garbage: true }, updatedAt: sql`${OLD_STAMP}` })
          .where(eq(themePackages.id, seed.id));
        const before = (await read(seed.id)).revision;
        expect(await resetToBuiltin(db, seed.id)).toBe(1);
        const row = await read(seed.id);
        expect(row.definition).toEqual(seed.definition);
        expect(row.revision).toBe(before + 1);
        expect(await stampOf(seed.id)).not.toBe(OLD_STAMP);
        expect(await jsonTypeAt(seed.id, "$")).toBe("OBJECT");
      }
    });

    it("不是内置种子的 id 返回 0，自定义包不受影响", async () => {
      const id = await insertPack({ surfaces: {}, mine: true });
      expect(await resetToBuiltin(db, id)).toBe(0);
      expect(await resetToBuiltin(db, "no-such-pack")).toBe(0);
      expect(await read(id)).toEqual({ definition: { surfaces: {}, mine: true }, revision: 1 });
      expect(await stampOf(id)).toBe(OLD_STAMP);
    });

    it("传入事务句柄：提交后生效，回滚后定义与 revision 都不变", async () => {
      const seed = BUILTIN_THEME_PACK_SEEDS[0]!;
      const tampered = { surfaces: {}, tampered: true };
      await db
        .update(themePackages)
        .set({ definition: tampered })
        .where(eq(themePackages.id, seed.id));
      const before = await read(seed.id);

      await expect(
        db.transaction(async (tx) => {
          expect(await resetToBuiltin(tx, seed.id)).toBe(1);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await read(seed.id)).toEqual(before);

      await db.transaction(async (tx) => {
        expect(await resetToBuiltin(tx, seed.id)).toBe(1);
      });
      const after = await read(seed.id);
      expect(after.definition).toEqual(seed.definition);
      expect(after.revision).toBe(before.revision + 1);
    });

    it("种子 id 但行已不是内置包（is_builtin = 0）时不动", async () => {
      const seed = BUILTIN_THEME_PACK_SEEDS[0]!;
      await db
        .update(themePackages)
        .set({ isBuiltin: false, definition: { surfaces: {}, mine: true } })
        .where(eq(themePackages.id, seed.id));
      try {
        const before = await read(seed.id);
        expect(await resetToBuiltin(db, seed.id)).toBe(0);
        expect(await read(seed.id)).toEqual(before);
      } finally {
        await db
          .update(themePackages)
          .set({ isBuiltin: true })
          .where(eq(themePackages.id, seed.id));
      }
    });
  });
});
