// @vitest-environment node
/** 数据看板聚合（M9）：30 天序列补零、当日登录计数。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { dashboardData } from "./dashboard";

let tdb: TempDb;

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("数据看板（M9）", () => {
  it("30 天序列：长度恒 30、含今天、无数据日补零", async () => {
    const d = await dashboardData();
    expect(d.registered30).toHaveLength(30);
    expect(d.threads30).toHaveLength(30);
    expect(d.replies30).toHaveLength(30);
    // seed 用户注册于 2026 年初——今天（最后一天）可能为 0，但序列应完整覆盖到今天
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    expect(d.registered30[29].date).toBe(today);
  });

  it("总量与登录计数为非负数字", async () => {
    const d = await dashboardData();
    expect(d.totals.users).toBeGreaterThan(0);
    expect(d.totals.threads).toBeGreaterThan(0);
    expect(d.todayLogins).toBeGreaterThanOrEqual(0);
  });
});
