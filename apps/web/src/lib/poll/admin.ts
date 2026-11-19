import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getWebDb, pollOptions, polls, pollVotes, threads } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import { AdminError } from "@/lib/authz/admin";
import { checkPermission } from "@/lib/authz/service";
import type { DbTx } from "@/lib/audit";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { pageBounds } from "@/lib/paging";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";

/**
 * 投票管理（M10 补做，admin.reports？否——用 forum.moderate 作用域 + site.admin 两级）：
 *  · 列表：site.admin 看全站，版主看所辖版块（与审核队列同口径）；
 *  · 关闭投票 = ends_at 置当前（可恢复语义：置回 NULL 由编辑完成，本期不做编辑）；
 *  · 删除投票 = 删 polls/poll_options/poll_votes 三表行 + 主题 kind 回 normal + 审计。
 * 权限口径：版主可关/删**所辖版块**的投票；site.admin 全站。
 * M20.3 Step 4：守卫拆为 lock（行存在性锁）/apply（鉴权+状态裁决+写入+审计）共享内核，
 * 后台入口（抛 AdminError）与本文件尾部的管理 REST prepare 变体（Result denial）共用。
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

/** 投票写操作的域拒绝码（M20.3 Step 4）：REST 变体用 Result denial，后台入口转 AdminError 抛出 */
export type PollErrorCode = "not_found" | "already" | "forbidden";

type PollDenial = ModerationWriteDenial<PollErrorCode>;

/** 锁段共享内核取到的投票行（join 主题带出版块归属，供鉴权与审计复用） */
type LockedPollRow = {
  id: number;
  threadId: number;
  forumId: number;
  endsAt: string | null;
};

/** 事务内共享内核（后台与 REST lock 段共用）：按 poll id 行锁取投票行；只锁行，不做任何裁决 */
async function lockPollTarget(tx: DbTx, pollId: number): Promise<LockedPollRow | null> {
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
  return poll ?? null;
}

/**
 * 事务内共享内核（仅 REST lock 段）：按 polls.threadId 唯一索引（uq_polls_thread）换算投票行。
 * REST 路径以 threadId 定位投票；行不存在由调用方返回 not_found denial。
 */
async function lockPollTargetByThread(tx: DbTx, threadId: number): Promise<LockedPollRow | null> {
  const [poll] = await tx
    .select({
      id: polls.id,
      threadId: polls.threadId,
      forumId: threads.forumId,
      endsAt: polls.endsAt,
    })
    .from(polls)
    .innerJoin(threads, eq(threads.id, polls.threadId))
    .where(eq(polls.threadId, threadId))
    .for("update");
  return poll ?? null;
}

/**
 * 执行段共享内核（后台与 REST 同源）：服务层实时鉴权——site.admin 全站；
 * 否则须为该投票所在版块的版主。主体从库加载（admin 短路）——不能合成 Subject（roles 为空必拒）。
 */
async function authorizePollOperator(
  admin: ConfigActor & { userId: number },
  forumId: number,
): Promise<PollDenial | null> {
  const { loadSubject } = await import("@/lib/authz/subject");
  const operator = await loadSubject(admin.userId);
  const isSiteAdmin = (await checkPermission(operator, "site.admin")).allowed;
  if (!isSiteAdmin) {
    const allowed = (await checkPermission(operator, "forum.moderate", { forumId })).allowed;
    if (!allowed) return { ok: false, code: "forbidden", message: "你不是该版块的版主" };
  }
  return null;
}

/** 执行段共享内核：重开投票（仍在进行中 → already；截止时间置回 NULL + 审计） */
async function applyPollReopen(
  tx: DbTx,
  admin: ConfigActor & { userId: number },
  poll: LockedPollRow,
  trace?: ModerationApiTrace,
): Promise<{ ok: true } | PollDenial> {
  const denied = await authorizePollOperator(admin, poll.forumId);
  if (denied) return denied;
  if (poll.endsAt === null) {
    return { ok: false, code: "already", message: "该投票仍在进行中，无需重开" };
  }
  await tx.update(polls).set({ endsAt: null }).where(eq(polls.id, poll.id));
  await writeAudit(tx, {
    actorId: admin.userId,
    action: "poll.reopen",
    targetType: "poll",
    targetId: poll.id,
    after: {
      threadId: poll.threadId,
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
  return { ok: true };
}

/** 执行段共享内核：关闭投票（已截止 → already；ends_at 置当前 + 审计） */
async function applyPollClose(
  tx: DbTx,
  admin: ConfigActor & { userId: number },
  poll: LockedPollRow,
  trace?: ModerationApiTrace,
): Promise<{ ok: true } | PollDenial> {
  const denied = await authorizePollOperator(admin, poll.forumId);
  if (denied) return denied;
  if (poll.endsAt !== null && poll.endsAt <= nowBeijingWallTime()) {
    return { ok: false, code: "already", message: "该投票已截止" };
  }
  await tx.update(polls).set({ endsAt: nowBeijingWallTime() }).where(eq(polls.id, poll.id));
  await writeAudit(tx, {
    actorId: admin.userId,
    action: "poll.close",
    targetType: "poll",
    targetId: poll.id,
    after: {
      threadId: poll.threadId,
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
  return { ok: true };
}

/** 执行段共享内核：删除投票（三表明细 + 主题 kind 回 normal + 审计；不可逆，确认页负责二次确认） */
async function applyPollDelete(
  tx: DbTx,
  admin: ConfigActor & { userId: number },
  poll: LockedPollRow,
  trace?: ModerationApiTrace,
): Promise<{ ok: true } | PollDenial> {
  const denied = await authorizePollOperator(admin, poll.forumId);
  if (denied) return denied;
  await tx.delete(pollVotes).where(eq(pollVotes.pollId, poll.id));
  await tx.delete(pollOptions).where(eq(pollOptions.pollId, poll.id));
  await tx.delete(polls).where(eq(polls.id, poll.id));
  await tx.update(threads).set({ kind: "normal" }).where(eq(threads.id, poll.threadId));
  await writeAudit(tx, {
    actorId: admin.userId,
    action: "poll.delete",
    targetType: "poll",
    targetId: poll.id,
    after: {
      threadId: poll.threadId,
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
  return { ok: true };
}

/**
 * 后台包装（行为与原 guardAndMutate 完全一致）：自开事务 + 死锁重试，行锁 → 鉴权 →
 * 状态裁决 → 写入+审计同事务；denial 按原文案转 AdminError 抛出。
 */
async function mutatePollOrThrow(
  admin: ConfigActor & { userId: number },
  pollId: number,
  apply: (tx: DbTx, poll: LockedPollRow) => Promise<{ ok: true } | PollDenial>,
): Promise<void> {
  await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const poll = await lockPollTarget(tx, pollId);
      if (!poll) throw new AdminError("投票不存在");
      const applied = await apply(tx, poll);
      if (!applied.ok) throw new AdminError(applied.message ?? "投票操作失败");
    }, POINTS_TX_OPTIONS),
  );
}

/** 重开投票（M9.5 站长拍板补能力）：截止时间置回 NULL（恢复进行中），仅未删除的投票可重开 */
export async function reopenPoll(
  admin: ConfigActor & { userId: number },
  pollId: number,
): Promise<void> {
  await mutatePollOrThrow(admin, pollId, (tx, poll) => applyPollReopen(tx, admin, poll));
}

/** 关闭投票（ends_at 置当前；幂等：已关闭报 already） */
export async function closePoll(
  admin: ConfigActor & { userId: number },
  pollId: number,
): Promise<void> {
  await mutatePollOrThrow(admin, pollId, (tx, poll) => applyPollClose(tx, admin, poll));
}

/** 删除投票（三表明细 + 主题 kind 回 normal + 审计；不可逆，确认页负责二次确认） */
export async function deletePoll(
  admin: ConfigActor & { userId: number },
  pollId: number,
): Promise<void> {
  await mutatePollOrThrow(admin, pollId, (tx, poll) => applyPollDelete(tx, admin, poll));
}

// ============================================================
// REST 写变体（M20.3 Step 4）：prepare/lock/execute 三段式，供管理 REST 幂等
// 管线接入；与后台入口共享 lock/apply 内核，鉴权与写入/审计语义完全一致。
// REST 路径以 threadId 定位投票（polls.threadId 唯一索引 uq_polls_thread 换算）。
// 幂等契约：lock 段只做存在性锁（threadId→poll 换算 / not_found），可变状态裁决
// （鉴权、已截止/进行中）统一在 execute——合法回放在进入本函数前已被幂等缓存短路，
// 不会重复裁决；execute 闭包捕获 lock 的 tx，在同一事务内完成写入与审计。
// ============================================================

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。
 * 越权与不存在同型 not_found（不泄露存在性）；已截止/进行中等状态冲突 → state_conflict。 */
export const POLLS_DENIAL_HTTP = {
  not_found: "not_found",
  already: "state_conflict",
  forbidden: "not_found",
} as const;

/** REST 三段式写变体的准备产物类型（data 回显投票与主题 id，denial 复用域拒绝码）。 */
export type PreparedPollWrite = PreparedModerationWrite<
  { pollId: number; threadId: number },
  PollErrorCode
>;

/** REST 关闭投票：threadId 换算与行锁在 lock 段；鉴权与已截止裁决在 execute。 */
export async function prepareApiPollClose(
  admin: ConfigActor & { userId: number },
  threadId: number,
  trace?: ModerationApiTrace,
): Promise<PreparedPollWrite | PollDenial> {
  return {
    ok: true,
    async lock(tx) {
      const poll = await lockPollTargetByThread(tx, threadId);
      if (!poll) return { ok: false as const, code: "not_found" as const, message: "投票不存在" };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyPollClose(tx, admin, poll, trace);
          if (!applied.ok) return applied;
          return { ok: true as const, data: { pollId: poll.id, threadId: poll.threadId } };
        },
      };
    },
  };
}

/** REST 重开投票：threadId 换算与行锁在 lock 段；鉴权与「仍在进行中」裁决在 execute。 */
export async function prepareApiPollReopen(
  admin: ConfigActor & { userId: number },
  threadId: number,
  trace?: ModerationApiTrace,
): Promise<PreparedPollWrite | PollDenial> {
  return {
    ok: true,
    async lock(tx) {
      const poll = await lockPollTargetByThread(tx, threadId);
      if (!poll) return { ok: false as const, code: "not_found" as const, message: "投票不存在" };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyPollReopen(tx, admin, poll, trace);
          if (!applied.ok) return applied;
          return { ok: true as const, data: { pollId: poll.id, threadId: poll.threadId } };
        },
      };
    },
  };
}

/** REST 删除投票：threadId 换算与行锁在 lock 段；鉴权在 execute（删除无额外状态裁决）。 */
export async function prepareApiPollDelete(
  admin: ConfigActor & { userId: number },
  threadId: number,
  trace?: ModerationApiTrace,
): Promise<PreparedPollWrite | PollDenial> {
  return {
    ok: true,
    async lock(tx) {
      const poll = await lockPollTargetByThread(tx, threadId);
      if (!poll) return { ok: false as const, code: "not_found" as const, message: "投票不存在" };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyPollDelete(tx, admin, poll, trace);
          if (!applied.ok) return applied;
          return { ok: true as const, data: { pollId: poll.id, threadId: poll.threadId } };
        },
      };
    },
  };
}
