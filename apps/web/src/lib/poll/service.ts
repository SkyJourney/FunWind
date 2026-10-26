import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getWebDb, polls, pollOptions, pollVotes } from "@funwind/db";
import type { Subject } from "@/lib/authz/types";
import { checkPermission } from "@/lib/authz/service";
import { nowBeijingWallTime } from "@/lib/datetime";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";

/**
 * 投票交互（M10，设计定调 1/4）：复合主键 (poll_id, option_id, user_id) 防重；改票 = 同事务删旧插新；
 * 截止后不可投；result_visibility=after_vote 且未投 → 计数隐藏。poll.voted 事件经 outbox（仅审计）。
 */

export type VoteCode =
  "login" | "not_found" | "forbidden" | "closed" | "option_invalid" | "option_limit";

export type VoteResult =
  { ok: true; optionIds: number[] } | { ok: false; code: VoteCode; message: string };

export interface PollOptionView {
  id: number;
  content: string;
  /** 投了这一项（当前用户） */
  voted: boolean;
  /** 票数与占比；不可见时为 null */
  count: number | null;
  percent: number | null;
}

export interface PollView {
  pollId: number;
  optionLimit: number;
  endsAt: string | null;
  closed: boolean;
  resultVisibility: "always" | "after_vote";
  /** 当前用户已投的选项（空 = 未投） */
  myOptionIds: number[];
  voterCount: number | null;
  totalVotes: number | null;
  options: PollOptionView[];
}

/** 截止判定（ends_at 非空且 ≤ 现在） */
export function isClosed(endsAt: string | null, now = nowBeijingWallTime()): boolean {
  return endsAt !== null && endsAt <= now;
}

/** 详情页投票视图（当前用户视角；未登录按 guest——只读结果 always 的才显示计数） */
export async function getPollView(viewer: Subject, threadId: number): Promise<PollView | null> {
  const db = getWebDb();
  const [poll] = await db.select().from(polls).where(eq(polls.threadId, threadId)).limit(1);
  if (!poll) return null;
  const options = await db
    .select({ id: pollOptions.id, content: pollOptions.content, voteCount: pollOptions.voteCount })
    .from(pollOptions)
    .where(eq(pollOptions.pollId, poll.id))
    .orderBy(asc(pollOptions.sortOrder), asc(pollOptions.id));

  const viewerId = viewer.userId;
  const myOptionIds =
    viewerId !== null
      ? (
          await db
            .select({ optionId: pollVotes.optionId })
            .from(pollVotes)
            .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, viewerId)))
        ).map((r) => r.optionId)
      : [];

  const closed = isClosed(poll.endsAt);
  const showResults = poll.resultVisibility === "always" || myOptionIds.length > 0 || closed;

  const totalVotes = options.reduce((sum, o) => sum + o.voteCount, 0);
  return {
    pollId: poll.id,
    optionLimit: poll.optionLimit,
    endsAt: poll.endsAt,
    closed,
    resultVisibility: poll.resultVisibility,
    myOptionIds,
    voterCount: showResults ? poll.voterCount : null,
    totalVotes: showResults ? totalVotes : null,
    options: options.map((o) => {
      const show = showResults;
      return {
        id: o.id,
        content: o.content,
        voted: myOptionIds.includes(o.id),
        count: show ? o.voteCount : null,
        percent:
          show && totalVotes > 0 ? Math.round((o.voteCount / totalVotes) * 100) : show ? 0 : null,
      };
    }),
  };
}

/** 投票/改票：options 为本次的完整选项集（单选 1 项，多选 ≤ optionLimit）。改票 = 同事务删旧插新。 */
export async function vote(
  viewer: Subject,
  threadId: number,
  optionIds: readonly number[],
): Promise<VoteResult> {
  if (viewer.userId === null) return { ok: false, code: "login", message: "请先登录" };
  const userId = viewer.userId;
  if (!(await checkPermission(viewer, "vote.participate")).allowed) {
    return { ok: false, code: "forbidden", message: "你没有参与投票的权限" };
  }
  const wanted = [...new Set(optionIds)];
  if (wanted.length === 0) return { ok: false, code: "option_invalid", message: "请选择至少一项" };

  const db = getWebDb();
  const enqueued: EnqueuedEvent[] = [];
  const failure = await withDeadlockRetry(() =>
    db.transaction(async (tx): Promise<VoteResult | null> => {
      const [poll] = await tx
        .select({ id: polls.id, optionLimit: polls.optionLimit, endsAt: polls.endsAt })
        .from(polls)
        .where(eq(polls.threadId, threadId))
        .limit(1);
      if (!poll) return { ok: false, code: "not_found", message: "投票不存在" };
      if (isClosed(poll.endsAt)) return { ok: false, code: "closed", message: "投票已截止" };
      if (wanted.length > poll.optionLimit) {
        return { ok: false, code: "option_limit", message: `最多可选 ${poll.optionLimit} 项` };
      }

      // 选项必须属于本投票
      const valid = await tx
        .select({ id: pollOptions.id })
        .from(pollOptions)
        .where(and(eq(pollOptions.pollId, poll.id), inArray(pollOptions.id, wanted)));
      if (valid.length !== wanted.length) {
        return { ok: false, code: "option_invalid", message: "包含无效的选项" };
      }

      // 旧票（改票 = 删旧插新；同 option 保留则跳过）
      const old = await tx
        .select({ optionId: pollVotes.optionId })
        .from(pollVotes)
        .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, userId)));
      const oldIds = old.map((r) => r.optionId);
      const removed = oldIds.filter((id) => !wanted.includes(id));
      const added = wanted.filter((id) => !oldIds.includes(id));
      if (added.length === 0 && removed.length === 0) {
        return { ok: true, optionIds: [...oldIds] }; // 重复提交同一组：幂等
      }

      if (removed.length > 0) {
        await tx
          .delete(pollVotes)
          .where(
            and(
              eq(pollVotes.pollId, poll.id),
              eq(pollVotes.userId, userId),
              inArray(pollVotes.optionId, removed),
            ),
          );
        await tx
          .update(pollOptions)
          .set({ voteCount: sql`GREATEST(${pollOptions.voteCount} - 1, 0)` })
          .where(inArray(pollOptions.id, removed));
      }
      if (added.length > 0) {
        try {
          await tx.insert(pollVotes).values(
            added.map((optionId) => ({
              pollId: poll.id,
              optionId,
              userId,
              createdAt: nowBeijingWallTime(),
            })),
          );
        } catch (e) {
          // 并发双击：复合主键撞键 → 幂等成功（旧票为准）
          if (isDuplicateKeyErr(e)) return { ok: true, optionIds: [...oldIds] };
          throw e;
        }
        await tx
          .update(pollOptions)
          .set({ voteCount: sql`${pollOptions.voteCount} + 1` })
          .where(inArray(pollOptions.id, added));
      }

      // voterCount = 去重投票人数（有票的用户数）
      const [{ n }] = await tx
        .select({ n: sql<number>`COUNT(DISTINCT user_id)` })
        .from(pollVotes)
        .where(eq(pollVotes.pollId, poll.id));
      await tx
        .update(polls)
        .set({ voterCount: Number(n) })
        .where(eq(polls.id, poll.id));

      enqueued.push(
        await enqueueEventInTx(
          tx,
          "poll.voted",
          { userId, pollId: poll.id, optionIds: [...wanted] },
          { actorId: userId, source: "poll" },
        ),
      );
      return null;
    }, POINTS_TX_OPTIONS),
  );

  if (failure !== null) return failure;
  await dispatchOutboxRows(enqueued);
  await sweepPending();
  const pollId = await pollThreadId(threadId);
  return { ok: true, optionIds: await currentOptionIds(userId, pollId) };
}

async function pollThreadId(threadId: number): Promise<number> {
  const [row] = await getWebDb()
    .select({ id: polls.id })
    .from(polls)
    .where(eq(polls.threadId, threadId))
    .limit(1);
  return row?.id ?? 0;
}

async function currentOptionIds(userId: number, pollId: number): Promise<number[]> {
  if (pollId === 0) return [];
  const rows = await getWebDb()
    .select({ optionId: pollVotes.optionId })
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, userId)));
  return rows.map((r) => r.optionId);
}

function isDuplicateKeyErr(e: unknown): boolean {
  const err = e as { code?: string; errno?: number; cause?: { code?: string } };
  return err?.code === "ER_DUP_ENTRY" || err?.errno === 1062 || err?.cause?.code === "ER_DUP_ENTRY";
}
