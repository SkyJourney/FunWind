// @vitest-environment node
/**
 * RUM 样本落库（M17 Step 4）· 真实临时库。
 * 端点侧的校验与脱敏由 route.test.ts 覆盖；这里只验落库本身：批量写入、字段保真、空输入短路。
 */
import { eq, sql } from "drizzle-orm";
import { getWebDb, rumSamples } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { recordRumSamples, type RumRow } from "./ingest";

let tdb: TempDb;
const db = () => getWebDb();

const vital: RumRow = { kind: "vital", name: "LCP", value: 1234, route: "/t/6621", detail: null };
const err: RumRow = {
  kind: "error",
  name: "js-error",
  value: 0,
  route: "/f/109",
  detail: "boom",
};

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
});

describe.skipIf(skipDb)("recordRumSamples", () => {
  it("空数组：返回 0 且不写库（不做无谓的空 insert）", async () => {
    expect(await recordRumSamples([])).toBe(0);
    const [{ n }] = await db()
      .select({ n: sql<number>`count(*)` })
      .from(rumSamples);
    expect(Number(n)).toBe(0);
  });

  it("批量写入：返回行数，字段逐字保真", async () => {
    expect(await recordRumSamples([vital, err])).toBe(2);
    const rows = await db().select().from(rumSamples).orderBy(rumSamples.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "vital",
      name: "LCP",
      value: 1234,
      route: "/t/6621",
      detail: null,
    });
    expect(rows[1]).toMatchObject({
      kind: "error",
      name: "js-error",
      value: 0,
      route: "/f/109",
      detail: "boom",
    });
  });

  it("同一批样本共用一个时间戳（便于按批排查）", async () => {
    await recordRumSamples([vital, err, { ...vital, name: "CLS", value: 42 }]);
    const rows = await db().select({ at: rumSamples.createdAt }).from(rumSamples);
    expect(new Set(rows.map((r) => r.at)).size).toBe(1);
  });

  it("多次调用各自成批（时间戳不互相覆盖）", async () => {
    await recordRumSamples([vital]);
    await recordRumSamples([err]);
    const rows = await db().select().from(rumSamples).orderBy(rumSamples.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe("vital");
    expect(rows[1]!.kind).toBe("error");
  });

  it("CLS 的 ×1000 整数值与 0 值都能正确落库（无浮点列）", async () => {
    await recordRumSamples([
      { ...vital, name: "CLS", value: 123 },
      { ...vital, name: "INP", value: 0 },
    ]);
    const rows = await db()
      .select({ name: rumSamples.name, value: rumSamples.value })
      .from(rumSamples)
      .orderBy(rumSamples.id);
    expect(rows).toEqual([
      { name: "CLS", value: 123 },
      { name: "INP", value: 0 },
    ]);
  });

  it("脱敏后的 route 原样存（落库层不再二次加工）", async () => {
    await recordRumSamples([{ ...vital, route: "/reset/:token" }]);
    const [row] = await db()
      .select({ route: rumSamples.route })
      .from(rumSamples)
      .where(eq(rumSamples.name, "LCP"));
    expect(row?.route).toBe("/reset/:token");
  });
});
