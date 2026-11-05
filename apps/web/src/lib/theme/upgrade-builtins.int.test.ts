/**
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getWebDb } from "@funwind/db";
import { backfillMissingSections, resetToBuiltin, swapIfUnchanged } from "./upgrade-builtins";
import { parseThemePackDefinition } from "./surface-schema";

describe("upgrade-builtins 集成测试（真实 MySQL）", () => {
  const db = getWebDb();
  const testId = "test-upgrade-pack";

  beforeAll(async () => {
    // 直接插入测试包：只有 surfaces，没有 tokens 和 pwa
    await db.execute(sql`
      INSERT INTO theme_packages (id, name, description, enabled, definition, revision, created_at, updated_at, assets)
      VALUES (${testId}, '测试升级包', '用于验证升级原语', 0, '{"surfaces":{}}', 1, NOW(), NOW(), '[]')
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM theme_packages WHERE id = ${testId}`);
  });

  describe("backfillMissingSections", () => {
    it("补齐缺失的 tokens 段", async () => {
      const tokens = { light: { colors: { primary: "#147ba9" } } };
      const affected = await backfillMissingSections(testId, { tokens });
      expect(affected).toBe(1);

      const rows = (
        await db.execute(sql`SELECT definition, revision FROM theme_packages WHERE id = ${testId}`)
      )[0] as unknown as Array<{ definition: unknown; revision: number }>;
      const row = rows[0];
      expect(row.revision).toBe(2);
      const def = parseThemePackDefinition(row.definition);
      expect(def?.ok).toBe(true);
      if (def?.ok) {
        expect(def.value.tokens).toEqual(tokens);
      }
    });

    it("已有段不覆盖（幂等）", async () => {
      const affected = await backfillMissingSections(testId, {
        tokens: { light: { colors: { primary: "#000000" } } },
      });
      expect(affected).toBe(0);

      const rows = (
        await db.execute(sql`SELECT definition, revision FROM theme_packages WHERE id = ${testId}`)
      )[0] as unknown as Array<{ definition: unknown; revision: number }>;
      const row = rows[0];
      expect(row.revision).toBe(2);
      const def = parseThemePackDefinition(row.definition);
      if (def?.ok) {
        expect(def.value.tokens?.light?.colors?.primary).toBe("#147ba9");
      }
    });

    it("可同时补齐多个段", async () => {
      const pwa = { themeColor: "#147ba9", backgroundColor: "#f6f3e7" };
      const affected = await backfillMissingSections(testId, { pwa });
      expect(affected).toBe(1);

      const rows = (
        await db.execute(sql`SELECT definition, revision FROM theme_packages WHERE id = ${testId}`)
      )[0] as unknown as Array<{ definition: unknown; revision: number }>;
      const row = rows[0];
      expect(row.revision).toBe(3);
      const def = parseThemePackDefinition(row.definition);
      if (def?.ok) {
        expect(def.value.pwa).toEqual(pwa);
      }
    });
  });

  describe("swapIfUnchanged", () => {
    it("值未变时替换并递增 revision", async () => {
      const affected = await swapIfUnchanged(
        testId,
        "$.tokens.light.colors.primary",
        "#147ba9",
        "#116a92",
      );
      expect(affected).toBe(1);

      const rows = (
        await db.execute(sql`SELECT definition, revision FROM theme_packages WHERE id = ${testId}`)
      )[0] as unknown as Array<{ definition: unknown; revision: number }>;
      const row = rows[0];
      expect(row.revision).toBe(4);
      const def = parseThemePackDefinition(row.definition);
      if (def?.ok) {
        expect(def.value.tokens?.light?.colors?.primary).toBe("#116a92");
      }
    });

    it("值已变时跳过", async () => {
      const affected = await swapIfUnchanged(
        testId,
        "$.tokens.light.colors.primary",
        "#147ba9",
        "#000000",
      );
      expect(affected).toBe(0);

      const rows = (
        await db.execute(sql`SELECT definition, revision FROM theme_packages WHERE id = ${testId}`)
      )[0] as unknown as Array<{ definition: unknown; revision: number }>;
      const row = rows[0];
      expect(row.revision).toBe(4);
      const def = parseThemePackDefinition(row.definition);
      if (def?.ok) {
        expect(def.value.tokens?.light?.colors?.primary).toBe("#116a92");
      }
    });
  });

  describe("resetToBuiltin", () => {
    it("重置为内置定义并递增 revision", async () => {
      const builtinDef = {
        surfaces: { page: { light: {} } },
        tokens: { light: { colors: { primary: "#000000" } } },
      };
      const affected = await resetToBuiltin(testId, builtinDef);
      expect(affected).toBe(1);

      const rows = (
        await db.execute(sql`SELECT definition, revision FROM theme_packages WHERE id = ${testId}`)
      )[0] as unknown as Array<{ definition: unknown; revision: number }>;
      const row = rows[0];
      expect(row.revision).toBe(5);
      const def = parseThemePackDefinition(row.definition);
      if (def?.ok) {
        expect(def.value.surfaces).toEqual(builtinDef.surfaces);
        expect(def.value.tokens?.light?.colors?.primary).toBe("#000000");
      }
    });
  });
});
