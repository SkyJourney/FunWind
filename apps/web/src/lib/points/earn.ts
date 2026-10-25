import { and, eq, gte, sql } from "drizzle-orm";
import { getWebDb, pointLedger } from "@funwind/db";
import type { DbTx } from "@/lib/audit";
import type { EventPayloads } from "@/modules/kernel/types";
import { emit } from "@/modules/kernel/bus";
import { lockAccount } from "./account";
import { applyPointsInTx, resolveChannelOrThrow, type ApplyPointsResult } from "./apply";
import { UnregisteredChannelError } from "./errors";
import { getPointRewardConfig } from "./reward-load";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "./retry";

/**
 * 发帖 / 回帖奖励（M7，docs/POINTS.md §3）：积分模块消费 `thread.created` / `thread.replied`（经 outbox 可靠派发）
 * 后走这里入账。幂等键 `thread:{id}` / `reply:{postId}`——outbox 的 at-least-once 重放不重复发放。
 *
 * 日上限执行口径（docs/POINTS.md §2.1）：**账户行锁内**按 (user, channel, 北京自然日) 聚合当日已发放额，
 * 「已发放额 + 本次金额」超过上限则跳过（上限不可逾越；不发不记账、不派发事件）。
 * 金额为 0（后台可配）同样跳过——渠道照常注册，语义是「关闭」。
 * 渠道随模块启停：模块被停用则消费者根本不会跑；这里对渠道缺失的防御性跳过只为测试注入场景。
 */

export type EarnChannel = "earn.post" | "earn.reply";

export interface EarnRequest {
  userId: number;
  channel: EarnChannel;
  /** 幂等键（thread:{id} / reply:{postId}） */
  idempotencyKey: string;
  refId: number;
}

export type EarnResult =
  | { awarded: true; result: ApplyPointsResult }
  | { awarded: false; reason: "zero_reward" | "daily_cap" | "channel_unavailable" };

/** 北京自然日零点（库内 DATETIME 同口径；NOW() 会话时区 +08:00） */
const todayStart = () => sql`CURDATE()`;

/** 当日该渠道已发放额（锁内调用；走 (user_id, channel, created_at) 索引） */
async function earnedToday(tx: DbTx, userId: number, channel: string): Promise<number> {
  const [row] = await tx
    .select({ sum: sql<number | null>`SUM(${pointLedger.delta})` })
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.userId, userId),
        eq(pointLedger.channel, channel),
        gte(pointLedger.createdAt, todayStart()),
      ),
    );
  return Number(row?.sum ?? 0);
}

/**
 * 发放一笔发帖/回帖奖励：自己的短事务（READ COMMITTED + 死锁重试），提交后派发 `points.changed`。
 * 调用方（模块消费者）在事件派发链上运行——它自己不再嵌套在外层事务里。
 */
export async function awardEarn(req: EarnRequest): Promise<EarnResult> {
  // 只把「渠道未注册/停用」当业务性跳过；读库等基础设施错误必须抛出——
  // 否则消费者正常返回，event_log 无任何错误痕迹，outbox 也不会补派
  const channel = await resolveChannelOrThrow(req.channel).catch((e) => {
    if (e instanceof UnregisteredChannelError) return null;
    throw e;
  });
  if (!channel) return { awarded: false, reason: "channel_unavailable" };

  const config = await getPointRewardConfig();
  const amount = req.channel === "earn.post" ? config.post : config.reply;
  const cap = req.channel === "earn.post" ? config.postDailyCap : config.replyDailyCap;
  if (amount <= 0) return { awarded: false, reason: "zero_reward" };

  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<ApplyPointsResult | { capReached: true }> => {
      // 先锁账户行（与台账写入同一事务；applyPointsInTx 内部的重复加锁是幂等的）
      await lockAccount(tx, req.userId);
      // 上限不可逾越：已发放额 + 本次金额 > 上限 → 跳过（锁内判定，并发下串行化后仍准确）
      if (cap > 0 && (await earnedToday(tx, req.userId, req.channel)) + amount > cap) {
        return { capReached: true };
      }
      return applyPointsInTx(
        tx,
        {
          userId: req.userId,
          channel: req.channel,
          delta: amount,
          idempotencyKey: req.idempotencyKey,
          ref: { type: req.channel === "earn.post" ? "thread" : "post", id: req.refId },
          note: req.channel === "earn.post" ? "发帖奖励" : "回帖奖励",
        },
        channel,
      );
    }, POINTS_TX_OPTIONS),
  );

  if ("capReached" in result) return { awarded: false, reason: "daily_cap" };
  if (result.event) {
    try {
      await emit("points.changed", result.event, { source: "points" });
    } catch (e) {
      console.error("[points] points.changed 派发失败（入账已提交）:", e);
    }
  }
  return { awarded: true, result };
}

/** 模块消费者：thread.created → earn.post */
export function awardForThreadCreated(
  payload: EventPayloads["thread.created"],
): Promise<EarnResult> {
  return awardEarn({
    userId: payload.authorId,
    channel: "earn.post",
    idempotencyKey: `thread:${payload.threadId}`,
    refId: payload.threadId,
  });
}

/** 模块消费者：thread.replied → earn.reply */
export function awardForThreadReplied(
  payload: EventPayloads["thread.replied"],
): Promise<EarnResult> {
  return awardEarn({
    userId: payload.authorId,
    channel: "earn.reply",
    idempotencyKey: `reply:${payload.postId}`,
    refId: payload.postId,
  });
}
