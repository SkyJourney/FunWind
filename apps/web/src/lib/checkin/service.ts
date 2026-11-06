import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { checkins, getWebDb } from "@funwind/db";
import { isDuplicateKey } from "@/lib/auth/register";
import { nowBeijingWallTime } from "@/lib/datetime";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";
import { applyPointsInTx, resolveChannelOrThrow, type ApplyPointsResult } from "@/lib/points/apply";
import { UnregisteredChannelError } from "@/lib/points/errors";
import { IdempotencyConflictError } from "@/lib/points/errors";
import { getPunchRewardConfig } from "@/lib/points/reward-load";
import { randomPunchReward } from "@/lib/points/reward-config";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import type { DbTx } from "@/lib/audit";
import { emit } from "@/modules/kernel/bus";

/**
 * 每日签到（M7，docs/milestones/M7-gamification.md）：
 *  · 北京时间自然日边界——签到日 = nowBeijingWallTime() 的日期部分（库内 DATETIME 同口径）；
 *  · 一个事务内完成「写 checkins + 发放 earn.checkin」（POINTS_TX_OPTIONS，M7-2 口径）；
 *    奖励随机（punch.reward min–max，旧站语义）；0 = 关闭奖励但仍记签到与连签；
 *  · 重复签到由 checkins 联合主键 (user_id, checkin_date) 兜底——并发双击第二笔拿到重复键 → 回滚整体；
 *  · `checkin.done` 经 outbox（与发帖同机制）。
 * 历史连签由迁移数据（旧 punch 流水提取的 checkins 行）驱动。
 */

export type CheckinResult =
  | { ok: true; reward: number; streak: number }
  | { ok: false; code: "already" | "channel_unavailable" };

/** 北京时间「今天」的日期部分（YYYY-MM-DD）。测试可注入 */
export function todayBeijing(nowMs = Date.now()): string {
  return nowBeijingWallTime(nowMs).slice(0, 10);
}

/** YYYY-MM-DD 的前一天（UTC 正午做日历步进，无时区/夏令时歧义） */
export function previousDay(date: string): string {
  const t = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    12,
  );
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}

/**
 * 连签天数：包含 end 这天、从它（或它前一天——若 end 当天未签）向前连续的天数。
 * 纯函数；dates 为该用户已有的签到日集合。
 */
export function streakFromDates(
  dates: ReadonlySet<string>,
  end: string,
  endCheckedIn: boolean,
): number {
  let cursor = endCheckedIn ? end : previousDay(end);
  let streak = 0;
  while (dates.has(cursor)) {
    streak++;
    cursor = previousDay(cursor);
  }
  return streak;
}

/**
 * 该用户「今天以前」的签到日（连签计算用）。按 1000 行一页向前翻页：
 * 只要最旧一页的首日与前一日连续（链条未断）就继续取——迁移数据里存在 1000 天以上的长连签，
 * 单页截断会把 streak 恒算成 1000。翻页上限 10 万行（274 年）作护栏。
 */
async function datesOf(tx: DbTx, userId: number): Promise<Set<string>> {
  const dates = new Set<string>();
  let cursor: string | null = null; // keyset：已取到的最旧日期
  for (let page = 0; page < 100; page++) {
    const condition =
      cursor === null
        ? eq(checkins.userId, userId)
        : and(eq(checkins.userId, userId), lt(checkins.checkinDate, cursor))!;
    const rows: { d: string }[] = await tx
      .select({ d: checkins.checkinDate })
      .from(checkins)
      .where(condition)
      .orderBy(desc(checkins.checkinDate))
      .limit(1000);
    if (rows.length === 0) break;
    for (const r of rows) dates.add(r.d);
    const oldest = rows[rows.length - 1].d;
    // 链条已断（最旧行的前一天不在集合里）→ 不可能再有更长的连续段
    if (!dates.has(previousDay(oldest))) break;
    cursor = oldest;
    if (rows.length < 1000) break;
  }
  return dates;
}

/** 重复签到：抛出以回滚整个事务（签到行与奖励都不留），外层还原成固定错误码 */
class RollbackCheckin extends Error {}

/**
 * 执行签到。today 缺省为北京时间的今天（测试/工具可注入）。
 * 奖励与签到记录原子落库；`checkin.done` 事件在事务内入 outbox、提交后快路径派发。
 */
export async function checkin(
  userId: number,
  opts: { today?: string } = {},
): Promise<CheckinResult> {
  const today = opts.today ?? todayBeijing();
  // 只把「渠道未注册/停用」当业务性跳过；基础设施错误照常抛出（见 lib/points/earn.ts 同款说明）
  const channel = await resolveChannelOrThrow("earn.checkin").catch((e) => {
    if (e instanceof UnregisteredChannelError) return null;
    throw e;
  });
  if (!channel) return { ok: false, code: "channel_unavailable" };
  const config = await getPunchRewardConfig();
  const reward = randomPunchReward(config);

  let enqueued: EnqueuedEvent[] = [];
  try {
    const result = await withDeadlockRetry(() =>
      getWebDb().transaction(
        async (tx): Promise<{ reward: number; streak: number; balance?: ApplyPointsResult }> => {
          // 每次尝试都从空开始（与 posting 同纪律）：被回滚尝试的事件不得带进派发
          enqueued = [];
          // 先写签到行：联合主键兜底重复签到（并发第二笔在这里撞键 → 整体回滚）
          try {
            await tx.insert(checkins).values({ userId, checkinDate: today, reward });
          } catch (e) {
            if (isDuplicateKey(e)) throw new RollbackCheckin();
            throw e;
          }

          const dates = await datesOf(tx, userId);
          const streak = streakFromDates(dates, today, true);

          // 奖励入账（0 = 关闭奖励，不记账；earn.checkin 无日上限——每天一次天然受限）
          const balance =
            reward > 0
              ? await applyPointsInTx(
                  tx,
                  {
                    userId,
                    channel: "earn.checkin",
                    delta: reward,
                    idempotencyKey: `checkin:${userId}:${today}`,
                    note: `签到奖励（连签 ${streak} 天）`,
                  },
                  channel,
                )
              : undefined;

          enqueued.push(
            await enqueueEventInTx(
              tx,
              "checkin.done",
              { userId, streak },
              { actorId: userId, source: "checkin" },
            ),
          );
          return { reward, streak, balance };
        },
        POINTS_TX_OPTIONS,
      ),
    );

    if (result.balance?.event) {
      try {
        await emit("points.changed", result.balance.event, { source: "points" });
      } catch (e) {
        console.error("[checkin] points.changed 派发失败（入账已提交）:", e);
      }
    }
    await dispatchOutboxRows(enqueued);
    await sweepPending();
    return { ok: true, reward: result.reward, streak: result.streak };
  } catch (e) {
    // 联合主键已兜底正常路径的重复签到；幂等冲突只可能出现在「签到行不在而台账在」的异常数据上
    // （如人工清理），同样按已签处理，不让用户吃 500
    if (e instanceof RollbackCheckin || e instanceof IdempotencyConflictError) {
      if (e instanceof IdempotencyConflictError)
        console.warn("[checkin] 幂等键冲突，按已签处理:", e);
      return { ok: false, code: "already" };
    }
    throw e;
  }
}

/** 签到状态（签到条渲染用）：今天是否已签、当前连签、本月已签天数 */
export interface CheckinStatus {
  today: string;
  checkedInToday: boolean;
  /** 连签天数：今天已签含今天，未签含到昨天为止 */
  streak: number;
  /** 本月已签的日期（YYYY-MM-DD） */
  monthDates: string[];
  /** 累计签到天数 */
  totalDays: number;
}

export async function getCheckinStatus(
  userId: number,
  opts: { today?: string } = {},
): Promise<CheckinStatus> {
  const today = opts.today ?? todayBeijing();
  const db = getWebDb();
  const rows = await db
    .select({ d: checkins.checkinDate })
    .from(checkins)
    .where(and(eq(checkins.userId, userId), lte(checkins.checkinDate, today)))
    .orderBy(desc(checkins.checkinDate))
    .limit(1000);
  const dates = new Set(rows.map((r) => r.d));
  const monthPrefix = today.slice(0, 7);
  const [totalRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(checkins)
    .where(eq(checkins.userId, userId));
  return {
    today,
    checkedInToday: dates.has(today),
    streak: streakFromDates(dates, today, dates.has(today)),
    monthDates: [...dates].filter((d) => d.startsWith(monthPrefix)).sort(),
    totalDays: Number(totalRow?.n ?? 0),
  };
}

/** 月份日历（签到页/迷你日历用）：某年某月该用户的签到日；month = "YYYY-MM"。上界用次月 1 日（短月的 -31 是非法 DATE） */
export async function getMonthCheckins(userId: number, month: string): Promise<string[]> {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const rows = await getWebDb()
    .select({ d: checkins.checkinDate })
    .from(checkins)
    .where(
      and(
        eq(checkins.userId, userId),
        gte(checkins.checkinDate, `${month}-01`),
        lt(checkins.checkinDate, nextMonth),
      ),
    )
    .orderBy(checkins.checkinDate);
  return rows.map((r) => r.d);
}
