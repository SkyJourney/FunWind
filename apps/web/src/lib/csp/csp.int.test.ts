// @vitest-environment node
/**
 * CSP 报告落库 / 查询 / 清扫（M17 Step 6）· 真实临时库。
 * 脱敏在路由层（extractReports/redactUri）已有单测；这里验落库映射、筛选分页、24h 概览、90 天清扫。
 */
import { sql } from "drizzle-orm";
import { cspReports, getWebDb } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { recordCspReports } from "./ingest";
import { cspSummary, queryCspReports } from "./queries";

let tdb: TempDb;
const db = () => getWebDb();

const report = (over: Record<string, string> = {}) => ({
  "violated-directive": "script-src",
  "effective-directive": "script-src-elem",
  "blocked-uri": "https://cdn.example.invalid/x.js",
  "document-uri": "https://qingyisub.top/admin/themes",
  "line-number": "4",
  disposition: "report",
  ...over,
});

const seedOld = () =>
  db()
    .insert(cspReports)
    .values({
      violatedDirective: "img-src",
      effectiveDirective: null,
      blockedUri: null,
      documentUri: "/old",
      sourceFile: null,
      lineNumber: null,
      disposition: "report",
      createdAt: sql`NOW() - INTERVAL 100 DAY`,
    });

beforeAll(async () => {
  tdb = await setupTempDb();
});
afterAll(async () => {
  await tdb?.teardown();
});
afterEach(async () => {
  await db()
    .delete(cspReports)
    .where(sql`1 = 1`);
  vi.restoreAllMocks();
});

describe.skipIf(skipDb)("recordCspReports 落库映射", () => {
  it("字段映射 + line-number 解析 + 截断", async () => {
    const n = await recordCspReports([report()]);
    expect(n).toBe(1);
    const [r] = await db().select().from(cspReports);
    expect(r).toMatchObject({
      violatedDirective: "script-src",
      effectiveDirective: "script-src-elem",
      blockedUri: "https://cdn.example.invalid/x.js",
      documentUri: "https://qingyisub.top/admin/themes",
      lineNumber: 4,
      disposition: "report",
    });
  });

  it("缺省字段为 null；violated-directive 缺失回退 unknown；非法 line-number 为 null", async () => {
    await recordCspReports([{ "document-uri": "/x", "line-number": "abc" }]);
    const [r] = await db().select().from(cspReports);
    expect(r?.violatedDirective).toBe("unknown");
    expect(r?.lineNumber).toBeNull();
    expect(r?.blockedUri).toBeNull();
  });

  it("空数组不写库", async () => {
    expect(await recordCspReports([])).toBe(0);
    const [{ n }] = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(cspReports);
    expect(Number(n)).toBe(0);
  });

  it("line-number 空值与超 INT UNSIGNED 上限均为 null，边界值保留（审查 A-P2-5）", async () => {
    await recordCspReports([
      report({ "line-number": "" }),
      report({ "line-number": "99999999999" }),
      report({ "line-number": "4294967295" }),
    ]);
    const rows = await db()
      .select({ l: cspReports.lineNumber })
      .from(cspReports)
      .orderBy(cspReports.id);
    expect(rows.map((r) => r.l)).toEqual([null, null, 4294967295]);
  });
});

describe.skipIf(skipDb)("queryCspReports 筛选分页 + cspSummary", () => {
  it("directive / document 筛选与分页", async () => {
    await recordCspReports([report(), report({ "violated-directive": "img-src" })]);
    expect((await queryCspReports({ directive: "script-src" })).total).toBe(1);
    expect((await queryCspReports({ document: "/admin/themes" })).total).toBe(2);
    expect((await queryCspReports({})).total).toBe(2);
    const p = await queryCspReports({ limit: 1, page: 1 });
    expect(p.items).toHaveLength(1);
    expect(p.total).toBe(2);
  });

  it("cspSummary 只数 24h + Top 指令", async () => {
    await recordCspReports([report(), report(), report({ "violated-directive": "img-src" })]);
    await seedOld();
    const s = await cspSummary();
    expect(s.recent).toBe(3);
    expect(s.top[0]).toEqual({ directive: "script-src", n: 2 });
  });
});

describe.skipIf(skipDb)("90 天写侧概率清扫", () => {
  it("触发删超期、保留新；不触发保留", async () => {
    await seedOld();
    vi.spyOn(Math, "random").mockReturnValue(0);
    await recordCspReports([report()]);
    let docs = (await db().select({ d: cspReports.documentUri }).from(cspReports)).map((r) => r.d);
    expect(docs).not.toContain("/old");

    await db()
      .delete(cspReports)
      .where(sql`1 = 1`);
    await seedOld();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await recordCspReports([report()]);
    docs = (await db().select({ d: cspReports.documentUri }).from(cspReports)).map((r) => r.d);
    expect(docs).toContain("/old");
  });
});
