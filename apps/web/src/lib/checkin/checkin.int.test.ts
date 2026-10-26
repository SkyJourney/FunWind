// @vitest-environment node
/**
 * 签到模块集成测试（M7 S5）：真实模块渠道（earn.checkin）、北京时间自然日、连签（迁移历史驱动）、
 * 重复签到兜底（联合主键）与并发口径（M7-2，POINTS_TX_OPTIONS）。
 */
import "@/modules";
import { and, eq, sql } from "drizzle-orm";
import { checkins, DEMO, eventLog, getWebDb, pointAccounts, siteSettings } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nowBeijingWallTime } from "@/lib/datetime";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { checkin, getCheckinStatus, previousDay, streakFromDates, todayBeijing } from "./service";

let tdb: TempDb;
const db = () => getWebDb();
const UID = DEMO.xiaoyi;

async function setPunch(min: number, max: number) {
  await db()
    .insert(siteSettings)
    .values({ key: "punch.reward", value: { min, max } as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: { min, max } as object, updatedAt: sql`NOW()` } });
}

async function balanceOf(userId: number): Promise<number> {
  const [row] = await db()
    .select({ balance: pointAccounts.balance })
    .from(pointAccounts)
    .where(eq(pointAccounts.userId, userId));
  return row?.balance ?? 0;
}

/** 直插历史签到日（checkins 不在积分守卫范围；日期为字符串 YYYY-MM-DD） */
async function seedDays(userId: number, dates: string[]) {
  for (const d of dates) {
    await db()
      .insert(checkins)
      .values({ userId, checkinDate: d, reward: 0 })
      .onDuplicateKeyUpdate({ set: { reward: 0 } });
  }
}

beforeAll(async () => {
  tdb = await setupTempDb();
  await setPunch(2, 2); // 固定奖励 2，消除随机性
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("签到（M7）", () => {
  it("todayBeijing 与库内北京墙面时间同口径；previousDay 纯日历步进", () => {
    expect(todayBeijing()).toBe(nowBeijingWallTime().slice(0, 10));
    expect(previousDay("2026-10-01")).toBe("2026-09-30");
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2028-03-01")).toBe("2028-02-29"); // 闰年
  });

  it("正常签到：奖励入账（earn.checkin）、checkin 行、checkin.done 经 outbox 派发", async () => {
    const today = todayBeijing();
    const before = await balanceOf(UID);
    const r = await checkin(UID);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.reward).toBe(2);
    expect(r.streak).toBe(1);
    expect((await balanceOf(UID)) - before).toBe(2);

    const [row] = await db()
      .select()
      .from(checkins)
      .where(and(eq(checkins.userId, UID), eq(checkins.checkinDate, today)));
    expect(row.reward).toBe(2);

    const done = await db().select().from(eventLog).where(eq(eventLog.eventName, "checkin.done"));
    expect(done).toHaveLength(1);
    expect(done[0].source).toBe("checkin");
    expect(done[0].actorId).toBe(UID);

    const changed = await db()
      .select()
      .from(eventLog)
      .where(eq(eventLog.eventName, "points.changed"));
    expect(changed.length).toBeGreaterThanOrEqual(1);
  });

  it("同日重复签到：already，不重复入账", async () => {
    const before = await balanceOf(UID);
    const r = await checkin(UID);
    expect(r).toEqual({ ok: false, code: "already" });
    expect(await balanceOf(UID)).toBe(before);
  });

  it("并发同日签到（M7-2）：20 路并发恰 1 路成功，其余 already（联合主键兜底）", async () => {
    const victim = DEMO.team;
    const before = await balanceOf(victim);
    const results = await Promise.all(Array.from({ length: 20 }, () => checkin(victim)));
    const okResults = results.filter((r) => r.ok);
    expect(okResults).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "already")).toHaveLength(19);
    expect((await balanceOf(victim)) - before).toBe(2);
  });

  it("连签：迁移历史 + 今日 → 连签 3；中断后重置为 1", async () => {
    const today = todayBeijing();
    const d1 = previousDay(today);
    const d2 = previousDay(d1);
    const u = 91234; // 任意未签到 uid（服务层由会话保证用户真实存在）
    await seedDays(u, [d1, d2]);
    const status = await getCheckinStatus(u);
    expect(status.checkedInToday).toBe(false);
    expect(status.streak).toBe(2); // 未签时连签到昨天为止

    const r = await checkin(u);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.streak).toBe(3);

    // 中断重置：另一个用户只签了大前天（昨天与前天都没签）
    const u2 = DEMO.member;
    await seedDays(u2, [previousDay(previousDay(d2))]);
    const r2 = await checkin(u2);
    if (!r2.ok) throw new Error(JSON.stringify(r2));
    expect(r2.streak).toBe(1);
  });

  it("奖励关闭（min=max=0）：签到与连签照记，不写台账", async () => {
    await setPunch(0, 0);
    const u = DEMO.alice;
    const before = await balanceOf(u);
    const r = await checkin(u);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.reward).toBe(0);
    expect(r.streak).toBe(1);
    expect(await balanceOf(u)).toBe(before);
    expect((await getCheckinStatus(u)).checkedInToday).toBe(true);
    await setPunch(2, 2);
  });

  it("getCheckinStatus：本月已签天数与累计天数", async () => {
    const s = await getCheckinStatus(UID);
    expect(s.checkedInToday).toBe(true);
    expect(s.monthDates).toContain(s.today);
    expect(s.totalDays).toBeGreaterThanOrEqual(1);
    // 台账对账未被签到破坏
    const [mismatch] = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(pointAccounts)
      .where(
        sql`${pointAccounts.balance} <> (
          SELECT COALESCE(SUM(delta), 0) FROM point_ledger WHERE point_ledger.user_id = point_accounts.user_id
        )`,
      );
    expect(Number(mismatch?.n ?? 0)).toBe(0);
  });

  it("today 注入：注入昨日可重复签到（分支覆盖，也证明时区无关的日期口径）", async () => {
    const u = 91235;
    const yesterday = previousDay(todayBeijing());
    const r1 = await checkin(u, { today: yesterday });
    expect(r1.ok).toBe(true);
    const r2 = await checkin(u, { today: todayBeijing() });
    if (!r2.ok) throw new Error(JSON.stringify(r2));
    expect(r2.streak).toBe(2); // 昨日 + 今日连签
  });

  it("streakFromDates 纯函数：跨月/跨年连续", () => {
    const dates = new Set(["2026-12-30", "2026-12-31", "2027-01-01"]);
    expect(streakFromDates(dates, "2027-01-01", true)).toBe(3);
    expect(streakFromDates(dates, "2027-01-02", false)).toBe(3);
    expect(streakFromDates(dates, "2027-01-02", true)).toBe(0);
  });
});
