// @vitest-environment node
/**
 * RUM 查询层与保留清扫（M17 Step 5）· 真实临时库。
 * 纯函数（parseRumFilter/percentile）由 queries.test.ts 覆盖；这里验 SQL 侧：
 * 筛选/分页/24h 概览/p75，以及 90 天写侧概率清扫。
 */
import { eq, sql } from "drizzle-orm";
import { getWebDb, rumSamples } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { recordRumSamples } from "./ingest";
import { queryRumSamples, rumPercentiles, rumSummary } from "./queries";

let tdb: TempDb;
const db = () => getWebDb();

const seed = (
  over: Partial<{ kind: "vital" | "error"; name: string; value: number; route: string }> = {},
) =>
  recordRumSamples([
    {
      kind: over.kind ?? "vital",
      name: over.name ?? "LCP",
      value: over.value ?? 1000,
      route: over.route ?? "/t/1",
      detail: null,
    },
  ]);

beforeAll(async () => {
  tdb = await setupTempDb();
});
afterAll(async () => {
  await tdb?.teardown();
});
afterEach(async () => {
  await db()
    .delete(rumSamples)
    .where(sql`1 = 1`);
  vi.restoreAllMocks();
});

describe.skipIf(skipDb)("queryRumSamples 筛选与分页", () => {
  it("kind / name / route 筛选各自生效", async () => {
    await seed({ kind: "vital", name: "LCP", route: "/t/1" });
    await seed({ kind: "vital", name: "CLS", route: "/t/2" });
    await seed({ kind: "error", name: "js-error", route: "/f/9" });

    expect((await queryRumSamples({ kind: "error" })).total).toBe(1);
    expect((await queryRumSamples({ name: "CLS" })).total).toBe(1);
    expect((await queryRumSamples({ route: "/t/" })).total).toBe(2);
    expect((await queryRumSamples({})).total).toBe(3);
  });

  it("route 筛选的通配符被转义（% 不当通配符）", async () => {
    await seed({ route: "/a%b" });
    await seed({ route: "/axb" });
    expect((await queryRumSamples({ route: "%" })).total).toBe(1);
  });

  it("分页：limit 与页码生效，total 不受分页影响", async () => {
    for (let i = 0; i < 5; i += 1) await seed({ value: i });
    const p1 = await queryRumSamples({ limit: 2, page: 1 });
    expect(p1.total).toBe(5);
    expect(p1.items).toHaveLength(2);
    const p3 = await queryRumSamples({ limit: 2, page: 3 });
    expect(p3.items).toHaveLength(1);
  });
});

describe.skipIf(skipDb)("概览与 p75", () => {
  it("rumSummary 只数最近 24h", async () => {
    await seed({ kind: "vital" });
    await seed({ kind: "error", name: "js-error" });
    // 一条 2 天前的，不应计入
    await db()
      .insert(rumSamples)
      .values({
        kind: "vital",
        name: "LCP",
        value: 1,
        route: "/old",
        detail: null,
        createdAt: sql`NOW() - INTERVAL 2 DAY`,
      });
    const s = await rumSummary();
    expect(s).toEqual({ vitals: 1, errors: 1 });
  });

  it("rumPercentiles 按指标名给 p75，空指标不出现", async () => {
    for (const v of [100, 200, 300, 400]) await seed({ name: "LCP", value: v });
    const p = await rumPercentiles();
    const lcp = p.find((x) => x.name === "LCP");
    expect(lcp).toMatchObject({ count: 4, p75: 300 });
    expect(p.find((x) => x.name === "CLS")).toBeUndefined();
  });
});

describe.skipIf(skipDb)("90 天写侧概率清扫", () => {
  it("触发时删除超期行、保留新行；不反噬写入", async () => {
    // 超期行（100 天前）
    await db()
      .insert(rumSamples)
      .values({
        kind: "vital",
        name: "LCP",
        value: 1,
        route: "/old",
        detail: null,
        createdAt: sql`NOW() - INTERVAL 100 DAY`,
      });
    // 强制触发清扫（Math.random=0 < 0.01）
    vi.spyOn(Math, "random").mockReturnValue(0);
    const written = await recordRumSamples([
      { kind: "vital", name: "LCP", value: 2, route: "/new", detail: null },
    ]);
    expect(written).toBe(1);
    const routes = (await db().select({ route: rumSamples.route }).from(rumSamples)).map(
      (r) => r.route,
    );
    expect(routes).toContain("/new");
    expect(routes).not.toContain("/old");
  });

  it("不触发时（Math.random=0.5）超期行保留", async () => {
    await db()
      .insert(rumSamples)
      .values({
        kind: "vital",
        name: "LCP",
        value: 1,
        route: "/old",
        detail: null,
        createdAt: sql`NOW() - INTERVAL 100 DAY`,
      });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await recordRumSamples([{ kind: "vital", name: "LCP", value: 2, route: "/new", detail: null }]);
    const n = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(rumSamples)
      .where(eq(rumSamples.route, "/old"));
    expect(Number(n[0]?.n)).toBe(1);
  });
});
