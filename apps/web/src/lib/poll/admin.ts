import { desc, eq, sql } from "drizzle-orm";
import { getWebDb, pollOptions, polls, pollVotes, threads } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import { AdminError } from "@/lib/authz/admin";
import { checkPermission } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";
import type { DbTx } from "@/lib/audit";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";

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

export async function pollAdminList(operator: Subject, limit = 50): Promise<PollAdminItem[]> {
  const isSiteAdmin = (await checkPermission(operator, "site.admin")).allowed;
  const moderated = isSiteAdmin ? null : await moderatedForumIds(operator);
  if (!isSiteAdmin && moderated !== null && moderated.length === 0) return [];

  const rows = await getWebDb()
    .select({
      pollId: polls.id,
      threadId: polls.threadId,
      title: threads.title,
      forumId: threads.forumId,
      endsAt: polls.endsAt,
      voterCount: polls.voterCount,
    })
    .from(polls)
    .innerJoin(threads, eq(threads.id, polls.threadId))
    .orderBy(desc(polls.id))
    .limit(limit * 2);

  const filtered = moderated ? rows.filter((r) => moderated!.includes(r.forumId)) : rows;

  const out: PollAdminItem[] = [];
  for (const r of filtered.slice(0, limit)) {
    const [{ forumName }] = await getWebDb()
      .select({ forumName: sql<string>`(SELECT name FROM forums WHERE id = ${r.forumId})` })
      .from(polls)
      .where(eq(polls.id, r.pollId));
    const options = await getWebDb()
      .select({ voteCount: pollOptions.voteCount })
      .from(pollOptions)
      .where(eq(pollOptions.pollId, r.pollId));
    const totalVotes = options.reduce((sum, o) => sum + o.voteCount, 0);
    out.push({
      pollId: r.pollId,
      threadId: r.threadId,
      title: r.title,
      forumId: r.forumId,
      forumName,
      optionCount: options.length,
      totalVotes,
      voterCount: r.voterCount,
      endsAt: r.endsAt,
      closed: r.endsAt !== null && r.endsAt <= nowBeijingWallTime(),
    });
  }
  return out;
}

async function moderatedForumIds(operator: Subject): Promise<number[] | null> {
  const { getModeratedForumIds } = await import("@/lib/authz/service");
  return getModeratedForumIds(operator);
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
