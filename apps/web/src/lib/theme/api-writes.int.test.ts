// @vitest-environment node
import { eq } from "drizzle-orm";
import { auditLog, getWebDb, themePackages } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManageApiError } from "@/lib/manage/errors";
import { runIdempotentManageWrite } from "@/lib/manage/idempotency";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getThemeCatalog, invalidateThemeCatalog } from "./catalog";
import {
  getEnabledThemePackCount,
  getThemePack,
  MAX_ENABLED_THEME_PACKS,
  prepareApiThemePackEnabled,
  prepareApiThemePackUpdate,
  THEMES_DENIAL_HTTP,
} from "./packs";

const actor = { userId: 1, via: "api", ip: "127.0.0.1" } as const;
const trace = { requestId: "theme-test-request", tokenSuffix: "theme-test" };
const definition = { surfaces: {} };
const assets = [{ kind: "logo", poolFile: `logo-${"a".repeat(32)}.png` }];

/** 在临时库插入夹具，避免将后台新建审计混入 REST 断言。 */
async function insertPack(id: string, enabled: boolean) {
  return getWebDb().insert(themePackages).values({
    id,
    name: id,
    description: "原说明",
    definition,
    assets,
    enabled,
    createdAt: "2026-11-20 12:00:00",
    updatedAt: "2026-11-20 12:00:00",
  });
}

/** 读取指定主题包的业务审计。 */
async function readAudits(id: string) {
  return await getWebDb().select().from(auditLog).where(eq(auditLog.targetId, id));
}

/** 通过真实幂等事务启用主题包，按 REST 码表处理域拒绝。 */
function enablePack(id: string, idempotencyKey: string) {
  return runIdempotentManageWrite(
    {
      tokenId: "a".repeat(64),
      endpoint: "themes.enabled",
      idempotencyKey,
      requestId: trace.requestId,
    },
    0,
    { packId: id, enabled: true },
    async (tx) => {
      const prepared = await prepareApiThemePackEnabled(actor, id, true, trace);
      if (!prepared.ok) throw new ManageApiError(THEMES_DENIAL_HTTP[prepared.code]);
      const locked = await prepared.lock(tx);
      if (!locked.ok) throw new ManageApiError(THEMES_DENIAL_HTTP[locked.code]);
      return async () => {
        const result = await locked.execute();
        if (!result.ok) throw new ManageApiError(THEMES_DENIAL_HTTP[result.code]);
        return result;
      };
    },
  );
}

let tdb: TempDb;

describe.skipIf(skipDb)("主题包管理 REST 写入", () => {
  beforeAll(async () => {
    tdb = await setupTempDb({ demo: false });
  });

  afterAll(async () => {
    invalidateThemeCatalog();
    await tdb?.teardown();
  });

  it("编辑只更新元数据和版本，回滚撤销审计，提交后回调才刷新目录", async () => {
    const id = "rest-edit";
    await insertPack(id, true);
    invalidateThemeCatalog();
    const cached = await getThemeCatalog();
    const prepared = await prepareApiThemePackUpdate(
      actor,
      id,
      1,
      { name: " 新名称 ", description: " 新说明 " },
      trace,
    );
    if (!prepared.ok) throw new Error(prepared.code);
    const write = async (commit: boolean) =>
      getWebDb().transaction(async (tx) => {
        const locked = await prepared.lock(tx);
        if (!locked.ok) throw new Error(locked.code);
        const result = await locked.execute();
        if (!result.ok) throw new Error(result.code);
        expect(result.data).toEqual({ id, revision: 2 });
        expect(await getThemeCatalog()).toBe(cached);
        if (!commit) throw new Error("测试回滚");
        return result;
      });

    await expect(write(false)).rejects.toThrow("测试回滚");
    expect(await getThemePack(id)).toMatchObject({ name: id, revision: 1 });
    expect(await readAudits(id)).toEqual([]);
    expect(await getThemeCatalog()).toBe(cached);

    const result = await write(true);
    expect(await getThemeCatalog()).toBe(cached);
    expect(result.afterCommit).toBeTypeOf("function");
    await result.afterCommit?.();
    expect(await getThemeCatalog()).toContainEqual(
      expect.objectContaining({ id, label: "新名称" }),
    );
    expect(await getThemePack(id)).toMatchObject({
      name: "新名称",
      description: "新说明",
      revision: 2,
      definition,
      assets,
    });
    expect(await readAudits(id)).toEqual([
      expect.objectContaining({
        actorId: actor.userId,
        action: "theme.pack.update",
        targetType: "theme_pack",
        beforeJson: { name: id, description: "原说明", revision: 1 },
        afterJson: { name: "新名称", description: "新说明", revision: 2, ...trace },
      }),
    ]);

    await getWebDb().transaction(async (tx) => {
      const locked = await prepared.lock(tx);
      if (!locked.ok) throw new Error(locked.code);
      expect(await locked.execute()).toMatchObject({ ok: false, code: "conflict" });
    });
    expect(await readAudits(id)).toHaveLength(1);
  });

  it("在执行阶段保护默认包，同值请求不写入、不审计、不返回缓存回调", async () => {
    const cache = await getThemeCatalog();
    const before = await getThemePack("default");
    if (!before) throw new Error("缺少默认主题包夹具");
    for (const enabled of [false, true]) {
      const prepared = await prepareApiThemePackEnabled(actor, "default", enabled);
      if (!prepared.ok) throw new Error(prepared.code);
      const result = await getWebDb().transaction(async (tx) => {
        const locked = await prepared.lock(tx);
        if (!locked.ok) throw new Error(locked.code);
        return locked.execute();
      });
      if (enabled) {
        expect(result).toEqual({
          ok: true,
          data: { id: "default", revision: before.revision, enabled: true, changed: false },
        });
      } else {
        expect(result).toMatchObject({ ok: false, code: "protected" });
      }
    }
    expect(await getThemePack("default")).toEqual(before);
    expect(await readAudits("default")).toEqual([]);
    expect(await getThemeCatalog()).toBe(cache);
  });

  it("并发争用最后一个启用名额时只成功一次，幂等回放不重复审计或刷新目录", async () => {
    const before = await getEnabledThemePackCount();
    for (let i = before; i < MAX_ENABLED_THEME_PACKS - 1; i++) {
      await insertPack(`rest-capacity-${i}`, true);
    }
    const ids = ["rest-candidate-a", "rest-candidate-b"];
    for (const id of ids) await insertPack(id, false);
    invalidateThemeCatalog();
    const cached = await getThemeCatalog();
    const writes = await Promise.allSettled(ids.map((id) => enablePack(id, id)));
    const winners = writes.filter((write) => write.status === "fulfilled");
    const losers = writes.filter((write) => write.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toMatchObject({ code: "state_conflict" });

    const winner = ids[writes.findIndex((write) => write.status === "fulfilled")];
    const loser = ids.find((id) => id !== winner)!;
    expect(winners[0].value).toEqual({ id: winner, revision: 2, enabled: true, changed: true });
    expect(await getEnabledThemePackCount()).toBe(MAX_ENABLED_THEME_PACKS);
    expect(await getThemePack(loser)).toMatchObject({ enabled: false, revision: 1 });
    expect(await readAudits(loser)).toEqual([]);
    const refreshed = await getThemeCatalog();
    expect(refreshed).not.toBe(cached);
    expect(refreshed.some((pack) => pack.id === winner)).toBe(true);
    expect(await enablePack(winner, winner)).toEqual(winners[0].value);
    expect(await getThemeCatalog()).toBe(refreshed);
    expect(await readAudits(winner)).toEqual([
      expect.objectContaining({
        action: "theme.pack.toggle",
        beforeJson: { enabled: false, revision: 1 },
        afterJson: { enabled: true, revision: 2, ...trace },
      }),
    ]);
  });
});
