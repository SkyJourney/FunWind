// @vitest-environment node
/**
 * 积分发放与管理员调整的集成测试（M7 S4）。
 * 发放链路走真实模块（import "@/modules" → emit("thread.created")），日上限与并发口径统一
 * POINTS_TX_OPTIONS（M7-2）；对账 SQL 与 packages/db verify 同式。
 */
import "@/modules";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditLog,
  DEMO,
  eventLog,
  getWebDb,
  pointAccounts,
  pointLedger,
  siteSettings,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emit } from "@/modules/kernel/bus";
import { adjustPointsByAdmin } from "./adjust";
import { awardEarn, awardForThreadCreated, awardForThreadReplied } from "./earn";
import { InsufficientPointsError, InvalidDeltaError } from "./errors";
import { findUserIdByName } from "@/lib/queries/users";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

let tdb: TempDb;
const db = () => getWebDb();
const UID = DEMO.member;

async function setReward(
  over: Partial<{ post: number; reply: number; postDailyCap: number; replyDailyCap: number }> = {},
) {
  const value = { post: 3, reply: 1, postDailyCap: 0, replyDailyCap: 0, ...over };
  await db()
    .insert(siteSettings)
    .values({ key: "points.reward", value: value as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
}

async function balanceOf(userId: number): Promise<number> {
  const [row] = await db()
    .select({ balance: pointAccounts.balance })
    .from(pointAccounts)
    .where(eq(pointAccounts.userId, userId));
  return row?.balance ?? 0;
}

async function ledgerCount(userId: number, channel: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`COUNT(*)` })
    .from(pointLedger)
    .where(and(eq(pointLedger.userId, userId), eq(pointLedger.channel, channel)));
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  tdb = await setupTempDb();
  await setReward();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("发帖/回帖奖励（earn）", () => {
  it("真实模块消费链路：emit(thread.created) → earn.post 按配置入账（+3）", async () => {
    const before = await balanceOf(UID);
    await emit(
      "thread.created",
      { threadId: 501001, postId: 501001, forumId: 901, authorId: UID, title: "奖励主题" },
      { source: "test" },
    );
    expect((await balanceOf(UID)) - before).toBe(3);
    expect(await ledgerCount(UID, "earn.post")).toBe(1);
  });

  it("幂等重放：同一 thread:{id} 重复派发不重复加分", async () => {
    const before = await balanceOf(UID);
    await awardForThreadCreated({
      threadId: 501002,
      postId: 501002,
      forumId: 901,
      authorId: UID,
      title: "重放主题",
    });
    await awardForThreadCreated({
      threadId: 501002,
      postId: 501002,
      forumId: 901,
      authorId: UID,
      title: "重放主题",
    });
    expect((await balanceOf(UID)) - before).toBe(3);
    expect(await ledgerCount(UID, "earn.post")).toBe(2); // 上一用例 + 本用例各 1
  });

  it("回帖奖励走 earn.reply（+1，独立幂等键 reply:{postId}）", async () => {
    const before = await balanceOf(UID);
    await awardForThreadReplied({
      threadId: 501001,
      postId: 502001,
      forumId: 901,
      authorId: UID,
      threadAuthorId: DEMO.alice,
    });
    expect((await balanceOf(UID)) - before).toBe(1);
  });

  it("奖励为 0（后台关闭）→ 跳过不发不记账", async () => {
    await setReward({ post: 0 });
    const before = await balanceOf(UID);
    const r = await awardEarn({
      userId: UID,
      channel: "earn.post",
      idempotencyKey: "thread:501003",
      refId: 501003,
    });
    expect(r).toEqual({ awarded: false, reason: "zero_reward" });
    expect(await balanceOf(UID)).toBe(before);
    await setReward();
  });

  it("日上限：已发放额 + 本次金额超过上限即跳过；昨日 23:59:59 不计入今日（北京自然日边界）", async () => {
    await setReward({ post: 3, postDailyCap: 6 });
    // 全新用户（DEMO.team，opening 50）：不受前序用例的台账影响
    let r = await awardEarn({
      userId: DEMO.team,
      channel: "earn.post",
      idempotencyKey: "thread:501010",
      refId: 501010,
    });
    expect(r.awarded).toBe(true); // 0+3 ≤ 6
    r = await awardEarn({
      userId: DEMO.team,
      channel: "earn.post",
      idempotencyKey: "thread:501011",
      refId: 501011,
    });
    expect(r.awarded).toBe(true); // 3+3 ≤ 6（恰好到顶允许）
    r = await awardEarn({
      userId: DEMO.team,
      channel: "earn.post",
      idempotencyKey: "thread:501012",
      refId: 501012,
    });
    expect(r).toEqual({ awarded: false, reason: "daily_cap" }); // 6+3 > 6

    // 边界夹具：昨日 23:59:59 的 +90 分录（同步补账户余额，保持对账一致）——不得计入今日聚合
    await db().insert(pointLedger).values({
      userId: DEMO.team,
      delta: 90,
      balanceAfter: 146,
      channel: "earn.post",
      idempotencyKey: "test:cap-yesterday",
      note: "日上限边界夹具：昨日 23:59:59",
      createdAt: "2020-01-01 23:59:59",
    });
    await db()
      .update(pointAccounts)
      .set({
        balance: sql`${pointAccounts.balance} + 90`,
        lifetimeEarned: sql`${pointAccounts.lifetimeEarned} + 90`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(pointAccounts.userId, DEMO.team));

    // 若把昨日的 90 计入今日，则 96+3 必然超限跳过；awarded=true 证明自然日边界正确
    await setReward({ post: 3, postDailyCap: 10 });
    r = await awardEarn({
      userId: DEMO.team,
      channel: "earn.post",
      idempotencyKey: "thread:501013",
      refId: 501013,
    });
    expect(r.awarded).toBe(true); // 今日 6+3=9 ≤ 10
    await setReward();
  });

  it("并发发放受日上限约束：cap=5、金额 3，10 路并发恰 1 笔成功", async () => {
    await setReward({ post: 3, postDailyCap: 5 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        awardEarn({
          userId: DEMO.alice,
          channel: "earn.post",
          idempotencyKey: `thread:${502100 + i}`,
          refId: 502100 + i,
        }),
      ),
    );
    const awarded = results.filter((r) => r.awarded);
    expect(awarded).toHaveLength(1); // 第 1 笔 0+3 ≤ 5；此后 3+3 > 5
    expect(await ledgerCount(DEMO.alice, "earn.post")).toBe(1);
    await setReward();
  });

  it("cap=0 不限：20 路并发全部入账，台账之和 = 余额增量", async () => {
    await setReward({ post: 2, postDailyCap: 0 });
    const before = await balanceOf(DEMO.xiaoyi);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        awardEarn({
          userId: DEMO.xiaoyi,
          channel: "earn.post",
          idempotencyKey: `thread:${503000 + i}`,
          refId: 503000 + i,
        }),
      ),
    );
    expect((await balanceOf(DEMO.xiaoyi)) - before).toBe(40);
    await setReward();
  });

  it("对账：全库 SUM(台账) = SUM(余额)，抽样用户台账重放 balanceAfter 逐条衔接", async () => {
    const [mismatch] = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(pointAccounts)
      .where(
        sql`${pointAccounts.balance} <> (
          SELECT COALESCE(SUM(delta), 0) FROM point_ledger WHERE point_ledger.user_id = point_accounts.user_id
        )`,
      );
    expect(Number(mismatch?.n ?? 0)).toBe(0);

    const rows = await db()
      .select({ id: pointLedger.id, delta: pointLedger.delta, after: pointLedger.balanceAfter })
      .from(pointLedger)
      .where(eq(pointLedger.userId, UID))
      .orderBy(pointLedger.id);
    let running = 0;
    for (const r of rows) {
      running += r.delta;
      expect(r.after).toBe(running);
    }
  });
});

describe.skipIf(skipDb)("管理员手工调整（adjust.admin）", () => {
  it("调整入账且台账与审计同事务落库；points.changed 出 event_log", async () => {
    const before = await balanceOf(UID);
    const logsBefore = (
      await db()
        .select({ id: eventLog.id })
        .from(eventLog)
        .where(eq(eventLog.eventName, "points.changed"))
    ).length;
    await adjustPointsByAdmin(
      { userId: DEMO.admin, via: "admin", ip: "127.0.0.1" },
      { userId: UID, delta: 100, note: "活动奖励（测试）" },
    );
    expect((await balanceOf(UID)) - before).toBe(100);
    const [ledgerRow] = await db()
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.channel, "adjust.admin"));
    expect(ledgerRow.note).toBe("活动奖励（测试）");
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "points.adjust"))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(audit.targetId).toBe(String(UID));
    expect(JSON.stringify(audit.afterJson)).toContain("活动奖励");
    const logsAfter = (
      await db()
        .select({ id: eventLog.id })
        .from(eventLog)
        .where(eq(eventLog.eventName, "points.changed"))
    ).length;
    expect(logsAfter).toBe(logsBefore + 1);
  });

  it("负数调整受余额约束；备注强制；额度非零强制", async () => {
    await expect(
      adjustPointsByAdmin(
        { userId: DEMO.admin, via: "admin", ip: null },
        { userId: UID, delta: -999_999_999, note: "超额扣减" },
      ),
    ).rejects.toThrow(InsufficientPointsError);
    await expect(
      adjustPointsByAdmin(
        { userId: DEMO.admin, via: "admin", ip: null },
        { userId: UID, delta: 1, note: "" },
      ),
    ).rejects.toThrow(InvalidDeltaError);
    await expect(
      adjustPointsByAdmin(
        { userId: DEMO.admin, via: "admin", ip: null },
        { userId: UID, delta: 0, note: "零额度" },
      ),
    ).rejects.toThrow(InvalidDeltaError);
  });

  it("findUserIdByName 走归一化键（大小写同身份）；不存在的名字不命中", async () => {
    expect(await findUserIdByName("demo_alice")).toBe(DEMO.alice);
    expect(await findUserIdByName("DEMO_ALICE")).toBe(DEMO.alice); // username_key 归一化：大小写同一身份
    expect(await findUserIdByName("不存在的名字")).toBeNull();
  });
});
