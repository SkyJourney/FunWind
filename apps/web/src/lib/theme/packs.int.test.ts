// @vitest-environment node
/**
 * 主题包写服务集成测试（M11.1 Step 5a）：新建/更新/启停/复制/删除 + 站点默认切换，
 * 覆盖 revision 乐观锁冲突、default 与内置包保护、审计写入（before/after/revision）。
 */
import { desc, eq, sql } from "drizzle-orm";
import { auditLog, getWebDb, siteSettings, themePackages } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import {
  copyThemePack,
  createThemePack,
  deleteThemePack,
  getDecorUsage,
  getEnabledThemePackCount,
  getSiteDefaultThemePack,
  getThemePack,
  listThemePacks,
  MAX_ENABLED_THEME_PACKS,
  parseThemePackAssets,
  setSiteDefaultThemePack,
  setThemePackLogo,
  setThemePackEnabled,
  updateThemePack,
  validatePackId,
} from "./packs";

let tdb: TempDb;
const actor = { userId: 1, via: "admin" as const, ip: null };

const DEF = {
  surfaces: { header: { light: { fill: { type: "solid" as const, color: "#112233" } } } },
};

beforeAll(async () => {
  tdb = await setupTempDb({ demo: false });
  invalidateThemeCatalog();
});

afterEach(async () => {
  await getWebDb().delete(themePackages).where(eq(themePackages.id, "demo-pk"));
  await getWebDb().delete(themePackages).where(eq(themePackages.id, "demo-pk-copy"));
  await getWebDb()
    .delete(themePackages)
    .where(
      sql`${themePackages.id} in ('capacity-a', 'capacity-b', 'capacity-c', 'capacity-d', 'capacity-e', 'capacity-copy')`,
    );
  await setThemePackEnabled("qy2010", true, actor);
  await getWebDb().delete(siteSettings).where(eq(siteSettings.key, "site.theme"));
  invalidateThemeCatalog();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("主题包写服务（M11.1 Step 5a）", () => {
  it("新建：入库 + revision=1 + 审计 theme.pack.create；同 id 重复被拒", async () => {
    const created = await createThemePack({
      id: "demo-pk",
      name: "演示包",
      description: "说明",
      definition: DEF,
      actor,
    });
    expect(created.ok).toBe(true);
    expect(created.value).toMatchObject({
      id: "demo-pk",
      name: "演示包",
      enabled: true,
      revision: 1,
    });

    const [audit] = await getWebDb()
      .select({ action: auditLog.action, targetId: auditLog.targetId })
      .from(auditLog)
      .where(eq(auditLog.action, "theme.pack.create"));
    expect(audit).toMatchObject({ targetId: "demo-pk" });

    const dup = await createThemePack({ id: "demo-pk", name: "再来", definition: DEF, actor });
    expect(dup).toMatchObject({ ok: false, code: "duplicate-id" });
  });

  it("新建：非法 definition 拒绝（不落库）；非法/保留 id 拒绝", async () => {
    const bad = await createThemePack({
      id: "demo-pk",
      name: "坏包",
      definition: { surfaces: { unknownArea: { light: {} } } },
      actor,
    });
    expect(bad).toMatchObject({ ok: false, code: "invalid-definition" });
    expect(await getThemePack("demo-pk")).toBeNull();

    expect(await createThemePack({ id: "X!", name: "n", definition: DEF, actor })).toMatchObject({
      ok: false,
      code: "bad-id",
    });
    expect(await createThemePack({ id: "dark", name: "n", definition: DEF, actor })).toMatchObject({
      ok: false,
      code: "reserved-id",
    });
    expect(validatePackId("ok-id")).toBeNull();
    expect(validatePackId("system")).toBe("reserved-id");
  });

  it("名称、缺失包、无 definition 更新与幂等启停均有明确结果", async () => {
    expect(
      await createThemePack({ id: "demo-pk", name: "   ", definition: DEF, actor }),
    ).toMatchObject({ ok: false, code: "bad-name" });
    await createThemePack({ id: "demo-pk", name: "演示包", definition: DEF, actor });
    expect(
      await updateThemePack({ id: "demo-pk", expectedRevision: 1, name: " ", actor }),
    ).toMatchObject({ ok: false, code: "bad-name" });
    expect(
      await updateThemePack({
        id: "demo-pk",
        expectedRevision: 1,
        definition: { surfaces: { evil: { light: {} } } },
        actor,
      }),
    ).toMatchObject({ ok: false, code: "invalid-definition" });
    expect(
      await updateThemePack({ id: "demo-pk", expectedRevision: 1, name: "只改名称", actor }),
    ).toMatchObject({ ok: true, value: { name: "只改名称", revision: 2 } });
    expect(await setThemePackEnabled("demo-pk", true, actor)).toMatchObject({
      ok: true,
      value: { enabled: true, revision: 2 },
    });
    expect(await updateThemePack({ id: "missing", expectedRevision: 1, actor })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(await setThemePackEnabled("missing", true, actor)).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(await deleteThemePack("missing", actor)).toMatchObject({ ok: false, code: "not-found" });
    expect(await copyThemePack("missing", "bad id", actor)).toMatchObject({
      ok: false,
      code: "bad-id",
    });
    expect(await copyThemePack("missing", "good-copy", actor)).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });

  it("资产清单只保留合法文件名和校验字段", () => {
    const logo = `logo-${"b".repeat(32)}.png`;
    const decor = `decor-${"a".repeat(32)}.png`;
    expect(parseThemePackAssets(null)).toEqual([]);
    expect(
      parseThemePackAssets([
        null,
        "bad",
        { kind: "script", poolFile: "logo-x.png" },
        { kind: "decor", poolFile: "../decor.png" },
        { kind: "logo", poolFile: logo, sha256: "B".repeat(64), bytes: 123 },
        { kind: "decor", poolFile: decor, sha256: "bad", bytes: -1 },
      ]),
    ).toEqual([
      { kind: "logo", poolFile: logo, sha256: "b".repeat(64), bytes: 123 },
      { kind: "decor", poolFile: decor },
    ]);
  });

  it("更新：revision 匹配则写入并 +1；不匹配 → conflict（不覆盖他人改动）", async () => {
    await createThemePack({ id: "demo-pk", name: "演示包", definition: DEF, actor });
    const ok = await updateThemePack({
      id: "demo-pk",
      expectedRevision: 1,
      name: "改名后",
      definition: DEF,
      actor,
    });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.value).toMatchObject({ name: "改名后", revision: 2 });

    const stale = await updateThemePack({
      id: "demo-pk",
      expectedRevision: 1, // 过期 revision
      name: "并发覆盖",
      definition: DEF,
      actor,
    });
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
    expect((await getThemePack("demo-pk"))?.name).toBe("改名后");

    const [audit] = await getWebDb()
      .select({ before: auditLog.beforeJson, after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "theme.pack.update"))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(audit?.before).toMatchObject({ name: "演示包", revision: 1 });
    expect(audit?.after).toMatchObject({ name: "改名后", revision: 2 });
  });

  it("启停：可停用自定义包；default 不可停用（protected）；审计记录 enabled 变化", async () => {
    await createThemePack({ id: "demo-pk", name: "演示包", definition: DEF, actor });
    const off = await setThemePackEnabled("demo-pk", false, actor);
    expect(off).toMatchObject({ ok: true });
    expect(off.value).toMatchObject({ enabled: false });

    const guarded = await setThemePackEnabled("default", false, actor);
    expect(guarded).toMatchObject({ ok: false, code: "protected" });
    expect((await getThemePack("default"))?.enabled).toBe(true);

    const [audit] = await getWebDb()
      .select({ before: auditLog.beforeJson, after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "theme.pack.toggle"));
    expect(audit?.before).toMatchObject({ enabled: true });
    expect(audit?.after).toMatchObject({ enabled: false });
  });

  it("删除：自定义包可删；内置包与 default 受保护（protected）", async () => {
    await createThemePack({ id: "demo-pk", name: "演示包", definition: DEF, actor });
    const removed = await deleteThemePack("demo-pk", actor);
    expect(removed).toMatchObject({ ok: true });
    expect(await getThemePack("demo-pk")).toBeNull();

    expect(await deleteThemePack("default", actor)).toMatchObject({ ok: false, code: "protected" });
    expect(await deleteThemePack("qy2010", actor)).toMatchObject({ ok: false, code: "protected" });
  });

  it("复制：以现有包为模板新建自定义包（新 id、独立 revision=1）", async () => {
    await createThemePack({ id: "demo-pk", name: "演示包", definition: DEF, actor });
    const copied = await copyThemePack("demo-pk", "demo-pk-copy", actor);
    expect(copied).toMatchObject({ ok: true });
    expect(copied.value).toMatchObject({ id: "demo-pk-copy", revision: 1, isBuiltin: false });
    expect(await getThemePack("demo-pk-copy")).not.toBeNull();
  });

  it("definition 资产引用同步入 assets；复制保留 LOGO 引用且重算 decor 引用", async () => {
    const decor = `decor-${"a".repeat(32)}.png`;
    const logo = `logo-${"b".repeat(32)}.png`;
    const imageDefinition = {
      surfaces: {
        "forum-band": {
          light: {
            fill: {
              type: "image",
              asset: decor,
              position: "top left",
              size: "cover",
              repeat: "no-repeat",
              blend: "soft-light",
              opacity: 0.7,
            },
            overlay: {
              type: "image",
              asset: decor,
              position: "center",
              size: "cover",
              repeat: "no-repeat",
              blend: "normal",
              opacity: 1,
            },
          },
        },
        header: { light: { contentSlot: { image: decor } } },
      },
    };
    await createThemePack({
      id: "demo-pk",
      name: "带素材包",
      definition: imageDefinition,
      assets: [{ kind: "logo", poolFile: logo }],
      actor,
    });
    const source = await getThemePack("demo-pk");
    expect(source?.assets).toEqual([
      { kind: "logo", poolFile: logo },
      { kind: "decor", poolFile: decor },
    ]);

    await copyThemePack("demo-pk", "demo-pk-copy", actor);
    const copied = await getThemePack("demo-pk-copy");
    expect(copied?.assets).toEqual(source?.assets);

    await updateThemePack({
      id: "demo-pk",
      expectedRevision: 1,
      definition: DEF,
      actor,
    });
    expect((await getThemePack("demo-pk"))?.assets).toEqual([{ kind: "logo", poolFile: logo }]);
  });

  it("LOGO 绑定：池外文件拒绝；池内绑定/解绑写 assets 与审计 theme.pack.logo", async () => {
    await createThemePack({ id: "demo-pk", name: "LOGO 主题", definition: DEF, actor });
    const logo = `logo-${"c".repeat(32)}.png`;
    expect(await setThemePackLogo("demo-pk", logo, actor)).toMatchObject({
      ok: false,
      code: "missing-assets",
    });

    // 写 site.logo 池元数据（池上传/验真管线由 logo-pool 集成测试覆盖；此处需可控文件名做绑定断言）
    const poolValue = { items: [{ file: logo, name: "测试 LOGO" }], active: logo };
    await getWebDb()
      .insert(siteSettings)
      .values({ key: "site.logo", value: poolValue, updatedAt: sql`NOW()` })
      .onDuplicateKeyUpdate({ set: { value: poolValue, updatedAt: sql`NOW()` } });

    const bound = await setThemePackLogo("demo-pk", logo, actor);
    expect(bound).toMatchObject({ ok: true });
    expect((await getThemePack("demo-pk"))?.assets).toContainEqual({
      kind: "logo",
      poolFile: logo,
    });
    const [logoAudit] = await getWebDb()
      .select({ action: auditLog.action, after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "theme.pack.logo"));
    expect(logoAudit?.after).toMatchObject({ logo });

    // 解绑只清 assets 中的 logo 项；decor 引用与池内文件不受影响
    expect(await setThemePackLogo("demo-pk", null, actor)).toMatchObject({ ok: true });
    expect((await getThemePack("demo-pk"))?.assets).toEqual([]);
    await getWebDb().delete(siteSettings).where(eq(siteSettings.key, "site.logo"));
  });

  it("getDecorUsage：输出 decorFile → 包与区域引用图谱", async () => {
    const decor = `decor-${"d".repeat(32)}.png`;
    await createThemePack({
      id: "demo-pk",
      name: "引用图谱包",
      definition: {
        surfaces: {
          "forum-band": {
            light: {
              fill: {
                type: "image",
                asset: decor,
                position: "center",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 1,
              },
            },
          },
          header: { light: { contentSlot: { image: decor } } },
        },
      },
      actor,
    });
    const usage = await getDecorUsage();
    const refs = usage.get(decor);
    expect(refs).toHaveLength(1);
    expect(refs?.[0]).toMatchObject({ packId: "demo-pk", packName: "引用图谱包" });
    expect(refs?.[0]?.surfaceIds.sort()).toEqual(["forum-band", "header"].sort());
    expect(usage.get("decor-not-referenced.png")).toBeUndefined();
  });

  it("站点默认切换：写入 site.theme + 审计；停用包不可设为默认", async () => {
    expect(await getSiteDefaultThemePack()).toBe("default");
    await createThemePack({ id: "demo-pk", name: "演示包", definition: DEF, actor });
    const set = await setSiteDefaultThemePack("demo-pk", actor);
    expect(set).toMatchObject({ ok: true, value: { pack: "demo-pk" } });
    await setSiteDefaultThemePack("demo-pk", actor);
    const [row] = await getWebDb()
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, "site.theme"));
    expect(row?.value).toMatchObject({ pack: "demo-pk" });
    const settingAudits = await getWebDb()
      .select({ action: auditLog.action, targetId: auditLog.targetId })
      .from(auditLog)
      .where(eq(auditLog.targetId, "site.theme"));
    expect(settingAudits).toHaveLength(1);
    expect(settingAudits[0]).toMatchObject({ action: "setting.update", targetId: "site.theme" });

    await setThemePackEnabled("demo-pk", false, actor);
    const rejected = await setSiteDefaultThemePack("demo-pk", actor);
    expect(rejected).toMatchObject({ ok: false, code: "protected" });
  });

  it("启用容量最多五包，创建并发、复制与重新启用均在事务内受限", async () => {
    expect(await getEnabledThemePackCount()).toBe(2);
    await createThemePack({ id: "capacity-a", name: "容量 A", definition: DEF, actor });
    await createThemePack({ id: "capacity-b", name: "容量 B", definition: DEF, actor });

    const [first, second] = await Promise.all([
      createThemePack({ id: "capacity-c", name: "容量 C", definition: DEF, actor }),
      createThemePack({ id: "capacity-d", name: "容量 D", definition: DEF, actor }),
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.code === "enabled-limit")).toHaveLength(1);
    expect(await getEnabledThemePackCount()).toBe(MAX_ENABLED_THEME_PACKS);

    const rejectedId = first.ok ? "capacity-d" : "capacity-c";
    expect(await getThemePack(rejectedId)).toBeNull();
    const [failedAudit] = await getWebDb()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.targetId, rejectedId));
    expect(failedAudit).toBeUndefined();

    const enabledId = first.ok ? "capacity-c" : "capacity-d";
    expect(await setThemePackEnabled(enabledId, false, actor)).toMatchObject({ ok: true });
    expect(
      await createThemePack({ id: "capacity-e", name: "容量 E", definition: DEF, actor }),
    ).toMatchObject({ ok: true });
    expect(await getEnabledThemePackCount()).toBe(MAX_ENABLED_THEME_PACKS);
    const beforeRetry = await getThemePack(enabledId);
    expect(await setThemePackEnabled(enabledId, true, actor)).toMatchObject({
      ok: false,
      code: "enabled-limit",
    });
    expect(await getThemePack(enabledId)).toEqual(beforeRetry);
    expect(await setThemePackEnabled("capacity-e", true, actor)).toMatchObject({ ok: true });

    expect(await copyThemePack("capacity-e", "capacity-copy", actor)).toMatchObject({
      ok: false,
      code: "enabled-limit",
    });
    expect(await getThemePack("capacity-copy")).toBeNull();
  });

  it("两个停用包并发启用竞争最后名额，只写入一份状态变更与审计", async () => {
    for (const id of ["capacity-a", "capacity-b", "capacity-c"]) {
      expect(await createThemePack({ id, name: id, definition: DEF, actor })).toMatchObject({
        ok: true,
      });
    }
    await setThemePackEnabled("capacity-a", false, actor);
    await setThemePackEnabled("capacity-b", false, actor);
    expect(
      await createThemePack({ id: "capacity-d", name: "补位", definition: DEF, actor }),
    ).toMatchObject({ ok: true });
    expect(await getEnabledThemePackCount()).toBe(4);
    const auditsBefore = await getWebDb().select({ id: auditLog.id }).from(auditLog);

    const results = await Promise.all([
      setThemePackEnabled("capacity-a", true, actor),
      setThemePackEnabled("capacity-b", true, actor),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.code === "enabled-limit")).toHaveLength(1);
    expect(await getEnabledThemePackCount()).toBe(MAX_ENABLED_THEME_PACKS);
    const auditsAfter = await getWebDb().select({ id: auditLog.id }).from(auditLog);
    expect(auditsAfter.length - auditsBefore.length).toBe(1);
    const loser = await getThemePack(results[0].ok ? "capacity-b" : "capacity-a");
    expect(loser).toMatchObject({ enabled: false, revision: 2 });
  });

  it("包列表：内置包在前；返回摘要含 surfaces 计数", async () => {
    await createThemePack({ id: "demo-pk", name: "演示包", definition: DEF, actor });
    const packs = await listThemePacks();
    expect(packs.map((p) => p.id)).toContain("demo-pk");
    expect(packs.find((p) => p.id === "demo-pk")?.surfaces).toBe(1);
    expect(packs.find((p) => p.id === "default")?.isBuiltin).toBe(true);
  });
});
