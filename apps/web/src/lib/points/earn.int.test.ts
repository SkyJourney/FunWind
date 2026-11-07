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
  campaigns,
  DEMO,
  eventLog,
  getWebDb,
  pointAccounts,
  pointLedger,
  siteSettings,
} from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { emit } from "@/modules/kernel/bus";
import { setModuleEnabled } from "@/modules/kernel/state";
import { CLI_ACTOR } from "@/lib/audit";
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

  it("模块停用：渠道解析失败 → channel_unavailable（业务性跳过，非静默吞错）", async () => {
    await setModuleEnabled("points", false, CLI_ACTOR);
    try {
      const before = await balanceOf(UID);
      const r = await awardEarn({
        userId: UID,
        channel: "earn.post",
        idempotencyKey: "thread:509999",
        refId: 509999,
      });
      expect(r).toEqual({ awarded: false, reason: "channel_unavailable" });
      expect(await balanceOf(UID)).toBe(before);
    } finally {
      await setModuleEnabled("points", true, CLI_ACTOR);
    }
  });

  it("earn.reply 的日上限独立生效（replyDailyCap）", async () => {
    await setReward({ post: 3, reply: 4, replyDailyCap: 4 });
    const u = DEMO.team;
    let r = await awardEarn({
      userId: u,
      channel: "earn.reply",
      idempotencyKey: "reply:600001",
      refId: 600001,
    });
    expect(r.awarded).toBe(true); // 0+4 ≤ 4
    r = await awardEarn({
      userId: u,
      channel: "earn.reply",
      idempotencyKey: "reply:600002",
      refId: 600002,
    });
    expect(r).toEqual({ awarded: false, reason: "daily_cap" }); // 4+4 > 4
    await setReward();
  });

  it("对账：全库 SUM(台账) = SUM(余额)，**全部账户**台账重放 balanceAfter 逐条衔接", async () => {
    const [mismatch] = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(pointAccounts)
      .where(
        sql`${pointAccounts.balance} <> (
          SELECT COALESCE(SUM(delta), 0) FROM point_ledger WHERE point_ledger.user_id = point_accounts.user_id
        )`,
      );
    expect(Number(mismatch?.n ?? 0)).toBe(0);

    const accounts = await db().select({ userId: pointAccounts.userId }).from(pointAccounts);
    expect(accounts.length).toBeGreaterThanOrEqual(4);
    for (const { userId } of accounts) {
      const rows = await db()
        .select({ delta: pointLedger.delta, after: pointLedger.balanceAfter })
        .from(pointLedger)
        .where(eq(pointLedger.userId, userId))
        .orderBy(pointLedger.id);
      let running = 0;
      for (const r of rows) {
        running += r.delta;
        expect(r.after, `用户 ${userId} 台账重放`).toBe(running);
      }
    }
  });
});

describe.skipIf(skipDb)("发放重放不因金额变化报冲突（M11.4 Step 3 F3）", () => {
  const req = (key: string, userId: number) => ({
    userId,
    channel: "earn.post" as const,
    idempotencyKey: key,
    refId: Number(key.split(":")[1]),
  });

  async function rowsFor(key: string) {
    return db().select().from(pointLedger).where(eq(pointLedger.idempotencyKey, key));
  }

  async function addBoost() {
    await db()
      .insert(campaigns)
      .values({
        name: "重放加成",
        effect: "points.boost",
        config: { ratio: 2 },
        startsAt: sql`NOW() - INTERVAL 1 HOUR`,
        endsAt: sql`NOW() + INTERVAL 1 HOUR`,
        enabled: true,
        revision: 1,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      });
  }

  afterEach(async () => {
    await db().delete(campaigns);
    await setReward();
  });

  it("无加成入账后开启加成再重放 → 按重放返回，不报冲突、不重复入账", async () => {
    await setReward({ post: 3 });
    const key = "thread:510001";
    const before = await balanceOf(DEMO.xiaoyi);
    const first = await awardEarn(req(key, DEMO.xiaoyi));
    expect(first.awarded).toBe(true);
    await addBoost();
    const replay = await awardEarn(req(key, DEMO.xiaoyi));
    expect(replay.awarded).toBe(true);
    if (replay.awarded) expect(replay.result.applied).toBe(false);
    expect(await balanceOf(DEMO.xiaoyi)).toBe(before + 3);
    expect(await rowsFor(key)).toHaveLength(1);
  });

  it("加成入账后关闭加成再重放 → 按重放返回，不报冲突、不重复入账", async () => {
    await setReward({ post: 3 });
    const key = "thread:510002";
    const before = await balanceOf(DEMO.xiaoyi);
    await addBoost();
    const first = await awardEarn(req(key, DEMO.xiaoyi));
    expect(first.awarded).toBe(true);
    if (first.awarded) expect(first.result.applied).toBe(true);
    expect(await balanceOf(DEMO.xiaoyi)).toBe(before + 6);
    await db().delete(campaigns);
    const replay = await awardEarn(req(key, DEMO.xiaoyi));
    expect(replay.awarded).toBe(true);
    if (replay.awarded) expect(replay.result.applied).toBe(false);
    expect(await balanceOf(DEMO.xiaoyi)).toBe(before + 6);
    expect(await rowsFor(key)).toHaveLength(1);
  });

  it("后台改奖励额后重放（存量隐患）→ 同样按重放返回，不报冲突", async () => {
    await setReward({ post: 3 });
    const key = "thread:510003";
    const before = await balanceOf(DEMO.xiaoyi);
    expect((await awardEarn(req(key, DEMO.xiaoyi))).awarded).toBe(true);
    await setReward({ post: 5 });
    const replay = await awardEarn(req(key, DEMO.xiaoyi));
    expect(replay.awarded).toBe(true);
    if (replay.awarded) expect(replay.result.applied).toBe(false);
    expect(await balanceOf(DEMO.xiaoyi)).toBe(before + 3);
    expect(await rowsFor(key)).toHaveLength(1);
  });

  it("不同用户 / 渠道共享幂等键仍属数据异常：照旧抛 IdempotencyConflictError", async () => {
    await setReward({ post: 3 });
    const key = "thread:510004";
    expect((await awardEarn(req(key, DEMO.xiaoyi))).awarded).toBe(true);
    await expect(
      awardEarn({ ...req(key, DEMO.team), channel: "earn.reply", refId: 610004 }),
    ).rejects.toThrow();
  });
});

describe.skipIf(skipDb)("活动加成（M11.4 Step 3，points.boost）", () => {
  afterEach(async () => {
    await db().delete(campaigns);
    await setReward();
  });

  async function addBoost(ratio = 2, name = "加成活动") {
    await db()
      .insert(campaigns)
      .values({
        name,
        effect: "points.boost",
        config: { ratio },
        startsAt: sql`NOW() - INTERVAL 1 HOUR`,
        endsAt: sql`NOW() + INTERVAL 1 HOUR`,
        enabled: true,
        revision: 1,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      });
  }

  it("×2 入账金额正确，台账 note 可追溯到方案与倍率，幂等键不变", async () => {
    await setReward({ post: 3 });
    await addBoost();
    const r = await awardEarn({
      userId: DEMO.xiaoyi,
      channel: "earn.post",
      idempotencyKey: "thread:511001",
      refId: 511001,
    });
    expect(r.awarded).toBe(true);
    // 断言分录本身而非累计余额：文件前序用例已给 xiaoyi 留下不确定的今日发放额
    const [row] = await db()
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.idempotencyKey, "thread:511001"));
    expect(row?.note).toBe("发帖奖励（活动加成 ×2：加成活动）");
    expect(row?.delta).toBe(6);
    // 幂等键语义不变：同键重放不重复发放
    await awardEarn({
      userId: DEMO.xiaoyi,
      channel: "earn.post",
      idempotencyKey: "thread:511001",
      refId: 511001,
    });
    expect(
      await db().select().from(pointLedger).where(eq(pointLedger.idempotencyKey, "thread:511001")),
    ).toHaveLength(1);
  });

  it("日上限同比放大：上限 5、金额 3，加成 ×2 后第一笔入账（6 ≤ 10）、第二笔被挡（12 > 10）", async () => {
    await setReward({ post: 3, postDailyCap: 5 });
    await addBoost();
    // banned（90003）在本文件的 earn.post 用例里从未被使用：今日已发放额确定为 0
    const u = DEMO.banned;
    let r = await awardEarn({
      userId: u,
      channel: "earn.post",
      idempotencyKey: "thread:511002",
      refId: 511002,
    });
    expect(r.awarded).toBe(true);
    r = await awardEarn({
      userId: u,
      channel: "earn.post",
      idempotencyKey: "thread:511003",
      refId: 511003,
    });
    expect(r).toEqual({ awarded: false, reason: "daily_cap" });
  });

  it("上限 0 = 不限：加成后仍不限（连发两笔 ×2 各 +4）", async () => {
    await setReward({ post: 2, postDailyCap: 0 });
    await addBoost();
    const before = await balanceOf(DEMO.xiaoyi);
    for (const id of [511004, 511005]) {
      const r = await awardEarn({
        userId: DEMO.xiaoyi,
        channel: "earn.post",
        idempotencyKey: `thread:${id}`,
        refId: id,
      });
      expect(r.awarded).toBe(true);
    }
    expect(await balanceOf(DEMO.xiaoyi)).toBe(before + 8);
  });

  it("加成下并发仍精确：金额 2→4、上限 5→10，3 路并发恰好 2 笔入账", async () => {
    await setReward({ post: 2, postDailyCap: 5 });
    await addBoost(2, "并发加成");
    // admin（90004）的 earn.post 今日台账为 0（此前只被 adjust.admin 用过）：前提确定
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        awardEarn({
          userId: DEMO.admin,
          channel: "earn.post",
          idempotencyKey: `thread:${512000 + i}`,
          refId: 512000 + i,
        }),
      ),
    );
    expect(results.filter((r) => r.awarded)).toHaveLength(2); // 4、8 ≤ 10；12 > 10
    expect(await ledgerCount(DEMO.admin, "earn.post")).toBe(2);
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
