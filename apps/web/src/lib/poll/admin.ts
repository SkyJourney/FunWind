import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getWebDb, pollOptions, polls, pollVotes, threads } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import { AdminError } from "@/lib/authz/admin";
import { checkPermission } from "@/lib/authz/service";
import type { DbTx } from "@/lib/audit";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { pageBounds } from "@/lib/queries/paging";

/**
 * 投票管理（M10 补做，admin.reports？否——用 forum.moderate 作用域 + site.admin 两级）：
 *  · 列表：site.admin 看全站，版主看所辖版块（与审核队列同口径）；
 *  · 关闭投票 = ends_at 置当前（可恢复语义：置回 NULL 由编辑完成，本期不做编辑）；
 *  · 删除投票 = 删 polls/poll_options/poll_votes 三表行 + 主题 kind 回 normal + 审计。
 * 权限口径：版主可关/删**所辖版块**的投票；site.admin 全站。
 */

export interface PollAdminItem {
  pollId: number;
  threadId: number;
  title: string;
  forumId: number;
  forumName: string;
  optionCount: number;
  totalVotes: number;
  voterCount: number;
  endsAt: string | null;
  closed: boolean;
}

/** 投票管理分页参数（M9.5）：状态 tab + 板块筛选 */
export type PollPageFilters = {
  status: "all" | "open" | "closed";
  forumId?: number;
  page: number;
  perPage?: number;
  /** 作用域：null = site.admin 全站；数组 = 版主所辖 */
  moderated: number[] | null;
};

/**
 * 投票管理列表（M9.5 重做）：一条聚合 SQL（选项数/票数用子查询聚合）+ COUNT 分页，
 * 替代原「limit*2 预取 + 每行 2 条子查询」的 N+1（满载约 101 条 SQL）。
 */
export async function listPollPage(
  filters: PollPageFilters,
): Promise<{ items: PollAdminItem[]; total: number; page: number; totalPages: number }> {
  const { forums: forumsTable } = await import("@funwind/db");
  const perPage = filters.perPage ?? 20;
  const conds = [];
  if (filters.status === "open") {
    conds.push(sql`(${polls.endsAt} IS NULL OR ${polls.endsAt} > NOW())`);
  } else if (filters.status === "closed") {
    conds.push(sql`(${polls.endsAt} IS NOT NULL AND ${polls.endsAt} <= NOW())`);
  }
  if (filters.forumId) conds.push(eq(threads.forumId, filters.forumId));
  if (filters.moderated) conds.push(inArray(threads.forumId, filters.moderated));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const [countRow] = await getWebDb()
    .select({ total: sql<number>`COUNT(*)` })
    .from(polls)
    .innerJoin(threads, eq(threads.id, polls.threadId))
    .where(where);
  const total = Number(countRow?.total ?? 0);
  const { page, totalPages, offset } = pageBounds(total, filters.page, perPage);
  const rows = await getWebDb()
    .select({
      pollId: polls.id,
      threadId: polls.threadId,
      title: threads.title,
      forumId: threads.forumId,
      forumName: forumsTable.name,
      optionCount:
        sql<number>`(SELECT COUNT(*) FROM poll_options po WHERE po.poll_id = ${polls.id})`.mapWith(
          Number,
        ),
      totalVotes:
        sql<number>`(SELECT COALESCE(SUM(po.vote_count), 0) FROM poll_options po WHERE po.poll_id = ${polls.id})`.mapWith(
          Number,
        ),
      voterCount: polls.voterCount,
      endsAt: polls.endsAt,
    })
    .from(polls)
    .innerJoin(threads, eq(threads.id, polls.threadId))
    .innerJoin(forumsTable, eq(forumsTable.id, threads.forumId))
    .where(where)
    .orderBy(desc(polls.id))
    .limit(perPage)
    .offset(offset);

  return {
    items: rows.map((r) => ({
      ...r,
      closed: r.endsAt !== null && r.endsAt <= nowBeijingWallTime(),
    })),
    total,
    page,
    totalPages,
  };
}

/** 重开投票（M9.5 站长拍板补能力）：截止时间置回 NULL（恢复进行中），仅未删除的投票可重开 */
export async function reopenPoll(
  admin: ConfigActor & { userId: number },
  pollId: number,
): Promise<void> {
  await guardAndMutate(admin, pollId, async (tx, poll) => {
    if (poll.endsAt === null) throw new AdminError("该投票仍在进行中，无需重开");
    await tx.update(polls).set({ endsAt: null }).where(eq(polls.id, pollId));
    await writeAudit(tx, {
      actorId: admin.userId,
      action: "poll.reopen",
      targetType: "poll",
      targetId: pollId,
      after: { threadId: poll.threadId, via: admin.via },
      ip: admin.ip,
    });
  });
}

/** 关闭投票（ends_at 置当前；幂等：已关闭报 already） */
export async function closePoll(
  admin: ConfigActor & { userId: number },
  pollId: number,
): Promise<void> {
  await guardAndMutate(admin, pollId, async (tx, poll) => {
    if (poll.endsAt !== null && poll.endsAt <= nowBeijingWallTime()) {
      throw new AdminError("该投票已截止");
    }
    await tx.update(polls).set({ endsAt: nowBeijingWallTime() }).where(eq(polls.id, pollId));
    await writeAudit(tx, {
      actorId: admin.userId,
      action: "poll.close",
      targetType: "poll",
      targetId: pollId,
      after: { threadId: poll.threadId, via: admin.via },
      ip: admin.ip,
    });
  });
}

/** 删除投票（三表明细 + 主题 kind 回 normal + 审计；不可逆，确认页负责二次确认） */
export async function deletePoll(
  admin: ConfigActor & { userId: number },
  pollId: number,
): Promise<void> {
  await guardAndMutate(admin, pollId, async (tx, poll) => {
    await tx.delete(pollVotes).where(eq(pollVotes.pollId, pollId));
    await tx.delete(pollOptions).where(eq(pollOptions.pollId, pollId));
    await tx.delete(polls).where(eq(polls.id, pollId));
    await tx.update(threads).set({ kind: "normal" }).where(eq(threads.id, poll.threadId));
    await writeAudit(tx, {
      actorId: admin.userId,
      action: "poll.delete",
      targetType: "poll",
      targetId: pollId,
      after: { threadId: poll.threadId, via: admin.via },
      ip: admin.ip,
    });
  });
}

/** 权限与加载共用守卫：site.admin 全站；否则须为该投票所在版块的版主 */
async function guardAndMutate(
  admin: ConfigActor & { userId: number },
  pollId: number,
  mutate: (
    tx: DbTx,
    poll: { id: number; threadId: number; forumId: number; endsAt: string | null },
  ) => Promise<void>,
): Promise<void> {
  await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const [poll] = await tx
        .select({
          id: polls.id,
          threadId: polls.threadId,
          forumId: threads.forumId,
          endsAt: polls.endsAt,
        })
        .from(polls)
        .innerJoin(threads, eq(threads.id, polls.threadId))
        .where(eq(polls.id, pollId))
        .for("update");
      if (!poll) throw new AdminError("投票不存在");
      // 主体从库加载（admin 短路；非 admin 需持该版块 forum.moderate）——不能合成 Subject（roles 为空必拒）
      const { loadSubject } = await import("@/lib/authz/subject");
      const operator = await loadSubject(admin.userId);
      const isSiteAdmin = (await checkPermission(operator, "site.admin")).allowed;
      if (!isSiteAdmin) {
        const allowed = (
          await checkPermission(operator, "forum.moderate", { forumId: poll.forumId })
        ).allowed;
        if (!allowed) throw new AdminError("你不是该版块的版主");
      }
      await mutate(tx, poll);
    }, POINTS_TX_OPTIONS),
  );
}
