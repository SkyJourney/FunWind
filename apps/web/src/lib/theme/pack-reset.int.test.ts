// @vitest-environment node
/**
 * 内置主题包重置服务集成测试（M11.6 Step 3f）：未找到 / 非内置 / 版本冲突 / 成功，
 * 成功时定义等于种子、名称说明启停不变、assets 重算、审计带旧定义、目录缓存失效；审计写失败则整体回滚。
 */
import { eq } from "drizzle-orm";
import { auditLog, BUILTIN_THEME_PACK_SEEDS, getWebDb, themePackages } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getThemeCatalog, invalidateThemeCatalog } from "@/lib/theme/catalog";
import { createThemePack } from "./packs";
import { resetThemePack } from "./pack-reset";

let tdb: TempDb;
let original: typeof themePackages.$inferSelect;
const actor = { userId: 1, via: "admin" as const, ip: null };
const ID = "qy2010";
const seed = BUILTIN_THEME_PACK_SEEDS.find((candidate) => candidate.id === ID)!;
const LOGO_FILE = `logo-${"a".repeat(32)}.png`;
const STALE_DECOR_FILE = `decor-${"b".repeat(32)}.png`;
/** 篡改后的定义引用了旧装饰图：若 assets 误按旧定义重算，旧装饰图会残留下来 */
const TAMPERED = {
  surfaces: {
    header: {
      light: {
        fill: {
          type: "image" as const,
          asset: STALE_DECOR_FILE,
          position: "center",
          size: "cover",
          repeat: "no-repeat" as const,
          blend: "normal" as const,
          opacity: 1,
        },
      },
    },
  },
};
const TAMPERED_ASSETS = [
  { kind: "logo", poolFile: LOGO_FILE },
  { kind: "decor", poolFile: STALE_DECOR_FILE },
];

const db = () => getWebDb();
const readPackById = async (id: string) =>
  (await db().select().from(themePackages).where(eq(themePackages.id, id)))[0]!;
const readPack = () => readPackById(ID);
/** 只按动作过滤：按固定目标过滤会让「别的包被误写审计」的断言空转 */
const resetAudits = () =>
  db().select().from(auditLog).where(eq(auditLog.action, "theme.pack.reset"));

beforeAll(async () => {
  tdb = await setupTempDb({ demo: false });
  original = await readPack();
});

afterEach(async () => {
  await db().update(themePackages).set(original).where(eq(themePackages.id, ID));
  await db().delete(auditLog).where(eq(auditLog.action, "theme.pack.reset"));
  await db().delete(themePackages).where(eq(themePackages.id, "mine"));
  invalidateThemeCatalog();
});

afterAll(async () => {
  await tdb?.teardown();
});

async function tamper() {
  await db()
    .update(themePackages)
    .set({
      name: "改过的名字",
      description: "改过的说明",
      definition: TAMPERED,
      assets: TAMPERED_ASSETS,
      revision: 7,
    })
    .where(eq(themePackages.id, ID));
}

describe.skipIf(skipDb)("内置主题包重置（M11.6 Step 3f）", () => {
  it("包不存在返回 not-found，不写审计", async () => {
    const result = await resetThemePack({ id: "no-such", expectedRevision: 1, actor });
    expect(result).toEqual({ ok: false, code: "not-found" });
    expect(await resetAudits()).toHaveLength(0);
  });

  // 偏移 5 = 页面已过期的自定义包：仍应报 not-builtin（刷新重试永远不会成功），而不是误导成 conflict
  it.each([0, 5])(
    "自定义包返回 not-builtin（expectedRevision 偏移 %i），定义与 revision 不变",
    async (offset) => {
      await createThemePack({ id: "mine", name: "我的", definition: TAMPERED, actor });
      const before = await readPackById("mine");
      const result = await resetThemePack({
        id: "mine",
        expectedRevision: before.revision + offset,
        actor,
      });
      expect(result).toEqual({ ok: false, code: "not-builtin" });
      expect(await readPackById("mine")).toEqual(before);
      expect(await resetAudits()).toHaveLength(0);
    },
  );

  it("带内置标记但不在种子清单里的行返回 not-builtin：不假装重置成功，也不写审计", async () => {
    await createThemePack({ id: "mine", name: "我的", definition: TAMPERED, actor });
    await db().update(themePackages).set({ isBuiltin: true }).where(eq(themePackages.id, "mine"));
    const before = await readPackById("mine");
    const result = await resetThemePack({ id: "mine", expectedRevision: before.revision, actor });
    expect(result).toEqual({ ok: false, code: "not-builtin" });
    expect(await readPackById("mine")).toEqual(before);
    expect(await resetAudits()).toHaveLength(0);
  });

  // 6 = 页面比库旧；8 = 页面比库新（不应出现，但严格相等才是「版本一致」的语义）
  it.each([6, 8])(
    "revision 不一致（库内 7，传入 %i）返回 conflict，定义不变且不写审计",
    async (stale) => {
      await tamper();
      const result = await resetThemePack({ id: ID, expectedRevision: stale, actor });
      expect(result).toEqual({ ok: false, code: "conflict" });
      const row = await readPack();
      expect(row.definition).toEqual(TAMPERED);
      expect(row.revision).toBe(7);
      expect(await resetAudits()).toHaveLength(0);
    },
  );

  it("成功：定义等于种子，名称说明启停不变，revision+1，assets 保留 LOGO 并去掉旧装饰图", async () => {
    await tamper();
    const result = await resetThemePack({ id: ID, expectedRevision: 7, actor });
    // assetCount 来自返回的摘要：校验返回值反映的是 assets 重算之后的行，而不是重算之前
    expect(result).toMatchObject({ ok: true, value: { id: ID, revision: 8, assetCount: 1 } });
    const row = await readPack();
    expect(row.definition).toEqual(seed.definition);
    expect(row.revision).toBe(8);
    expect(row.name).toBe("改过的名字");
    expect(row.description).toBe("改过的说明");
    expect(row.enabled).toBe(original.enabled);
    expect(row.assets).toEqual([{ kind: "logo", poolFile: LOGO_FILE }]);
  });

  it("成功时审计 before 带完整旧定义和旧 revision，after 带新 revision", async () => {
    await tamper();
    await resetThemePack({ id: ID, expectedRevision: 7, actor });
    const audits = await resetAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: 1,
      targetType: "theme_pack",
      targetId: ID,
      beforeJson: { revision: 7, definition: TAMPERED },
      afterJson: { revision: 8 },
    });
  });

  it("成功后目录缓存失效：下一次读到的是种子定义而不是缓存里的旧定义", async () => {
    await tamper();
    invalidateThemeCatalog();
    const cached = (await getThemeCatalog()).find((pack) => pack.id === ID);
    expect(cached?.definition).toEqual(TAMPERED);
    await resetThemePack({ id: ID, expectedRevision: 7, actor });
    const fresh = (await getThemeCatalog()).find((pack) => pack.id === ID);
    expect(fresh?.definition).toEqual(seed.definition);
  });

  it("审计写入失败时整体回滚：定义、revision、assets 都保持重置前", async () => {
    await tamper();
    const badActor = { userId: 1, via: "admin" as const, ip: "x".repeat(200) };
    await expect(
      resetThemePack({ id: ID, expectedRevision: 7, actor: badActor }),
    ).rejects.toThrow();
    const row = await readPack();
    expect(row.definition).toEqual(TAMPERED);
    expect(row.revision).toBe(7);
    expect(row.assets).toEqual(TAMPERED_ASSETS);
    expect(await resetAudits()).toHaveLength(0);
  });

  it("同一个旧版本并发重置：版本核对在行锁内完成，只有一次成功，其余 conflict", async () => {
    await tamper();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => resetThemePack({ id: ID, expectedRevision: 7, actor })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual(
      Array.from({ length: 3 }, () => ({ ok: false, code: "conflict" })),
    );
    expect((await readPack()).revision).toBe(8);
    expect(await resetAudits()).toHaveLength(1);
  });
});
