// @vitest-environment node
/**
 * 活动加成读取失败的回退（M11.4 Step 3 Q4）：排期读取抛错时按无加成发放（发放是主路径，
 * 不能因增强故障中断），并记一条带用户 / 渠道 / 幂等键的告警。
 * 本文件用文件级 mock 模拟「排期读取基础设施故障」——单独成文件，避免影响其他用例的真实读取链。
 */
import "@/modules";
import { eq, sql } from "drizzle-orm";
import { campaigns, DEMO, getWebDb, pointLedger, siteSettings } from "@funwind/db";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

vi.mock("@/lib/campaigns/service", () => ({
  getActivePointsBoost: async () => {
    throw new Error("模拟排期读取基础设施故障");
  },
}));

import { awardEarn } from "./earn";

let tdb: TempDb;
const db = () => getWebDb();

beforeAll(async () => {
  tdb = await setupTempDb();
  await db()
    .insert(siteSettings)
    .values({
      key: "points.reward",
      value: { post: 3, reply: 1, postDailyCap: 0, replyDailyCap: 0 } as object,
      updatedAt: sql`NOW()`,
    })
    .onDuplicateKeyUpdate({
      set: { value: { post: 3, reply: 1, postDailyCap: 0, replyDailyCap: 0 } as object },
    });
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("加成读取失败按无加成发放（Q4）", () => {
  afterEach(async () => {
    await db().delete(campaigns);
  });

  it("读取抛错 → 发放基础金额 +3，告警含渠道、幂等键与用户", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = (
      await db().select().from(pointLedger).where(eq(pointLedger.userId, DEMO.xiaoyi))
    ).length;
    const r = await awardEarn({
      userId: DEMO.xiaoyi,
      channel: "earn.post",
      idempotencyKey: "thread:513001",
      refId: 513001,
    });
    expect(r.awarded).toBe(true);
    const [row] = await db()
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.idempotencyKey, "thread:513001"));
    expect(row?.delta).toBe(3);
    expect(row?.note).toBe("发帖奖励");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("earn.post"), expect.any(Error));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("thread:513001"), expect.any(Error));
    expect(
      (await db().select().from(pointLedger).where(eq(pointLedger.userId, DEMO.xiaoyi))).length,
    ).toBe(before + 1);
    warn.mockRestore();
  });
});
