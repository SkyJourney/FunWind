import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { contentReviews, getWebDb, posts, threads, users } from "@funwind/db";
import type { ConfigActor, DbTx } from "@/lib/audit";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { nowBeijingWallTime } from "@/lib/datetime";
import { transitionContent } from "@/lib/posting/transition";
import { checkPermission } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";
import { publicUsername } from "@/lib/identity-expr";
import { pageBounds } from "@/lib/paging";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";

/**
 * 内容审核动作（M9，docs/milestones/M9-admin.md §2）：approve / reject / hide / disable。
 * 权限=forum.moderate（作用域=帖子所在版块）；状态迁移全部走 transitionContent（计数/审计/幂等唯一入口）；
 * content_reviews 与审计同事务；事件经事务性 outbox。
 *
 * approve 的关键机制（M9 拍板 1，兑现 kernel/types.ts:73 的契约注释）：
 * pending 路径此前只发过 content.submitted，**这里补发 thread.created / thread.replied**
 * ——积分奖励（earn.post/earn.reply）据此到位；幂等键 thread:{id} / reply:{postId} 兜底重放。
 */

export type ReviewCode =
  "not_found" | "forbidden" | "bad_state" | "reason_required" | "reason_too_long";

export type ReviewOutcome<T = undefined> =
  { ok: true; data?: T } | { ok: false; code: ReviewCode; message: string };

async function loadPostContext(postId: number) {
  const [row] = await getWebDb()
    .select({
      postId: posts.id,
      floor: posts.floor,
      postState: posts.state,
      authorId: posts.authorId,
      threadId: threads.id,
      forumId: threads.forumId,
      threadState: threads.state,
      firstPostId: threads.firstPostId,
      title: threads.title,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(eq(posts.id, postId))
    .limit(1);
  return row ?? null;
}

/** 版主权限：帖子所在版块的 forum.moderate */
async function canModerate(operator: Subject, forumId: number): Promise<boolean> {
  return (await checkPermission(operator, "forum.moderate", { forumId })).allowed;
}

const checkReason = (
  reason: string,
): { ok: true } | { ok: false; code: ReviewCode; message: string } => {
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, code: "reason_required", message: "必须填写理由" };
  if (trimmed.length > 255)
    return { ok: false, code: "reason_too_long", message: "理由太长（≤255 字）" };
  return { ok: true };
};

type ModerationAction = "approve" | "reject" | "hide" | "disable";
type ModerationSpec = {
  to: "visible" | "rejected" | "hidden" | "disabled";
  decision?: "approved" | "rejected" | "disabled";
  stateError: (state: string) => string | null;
};

const MODERATION_ACTIONS: Record<ModerationAction, ModerationSpec> = {
  approve: {
    to: "visible",
    decision: "approved",
    stateError: (state) =>
      state === "pending" ? null : `当前状态是 ${state}，只有待审内容可以通过`,
  },
  reject: {
    to: "rejected",
    decision: "rejected",
    stateError: (state) =>
      state === "pending" ? null : `当前状态是 ${state}，只有待审内容可以驳回`,
  },
  hide: {
    to: "hidden",
    stateError: (state) =>
      state === "visible" ? null : `当前状态是 ${state}，只有可见内容可以屏蔽`,
  },
  disable: {
    to: "disabled",
    decision: "disabled",
    stateError: (state) =>
      state === "disabled" ? "该内容已被封禁" : state === "deleted" ? "已删除内容不能封禁" : null,
  },
};

/** 共用审核流程；先鉴权、再状态、后理由，每次事务尝试只返回本次提交的事件。 */
async function runModerationAction(
  action: ModerationAction,
  operator: Subject,
  postId: number,
  actor: ConfigActor,
  reason?: string,
): Promise<ReviewOutcome> {
  if (operator.userId === null) return { ok: false, code: "forbidden", message: "请先登录" };
  const operatorId = operator.userId;
  const ctx = await loadPostContext(postId);
  if (!ctx) return { ok: false, code: "not_found", message: "帖子不存在" };
  if (!(await canModerate(operator, ctx.forumId))) {
    return { ok: false, code: "forbidden", message: "你不是该版块的版主" };
  }
  const spec = MODERATION_ACTIONS[action];
  const stateError = spec.stateError(ctx.postState);
  if (stateError) return { ok: false, code: "bad_state", message: stateError };
  if (action !== "approve") {
    const reasonCheck = checkReason(reason!);
    if (!reasonCheck.ok) return reasonCheck;
  }
  const note = action === "approve" ? "" : reason!.trim();

  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      // 被回滚尝试的事件不进入快路径缓存，也不泄露到下一次重试。
      const enqueued: EnqueuedEvent[] = [];
      const transition = await transitionContent(tx, postId, spec.to, {
        actorId: operatorId,
        ip: actor.ip,
        audit: true,
        ...(action !== "approve" ? { reason: note } : {}),
        ...(action === "disable" ? { actor: "moderator" as const } : {}),
      });
      if (!transition.ok) {
        return {
          ok: false as const,
          code:
            action === "approve" && transition.code === "not_found"
              ? ("not_found" as const)
              : ("bad_state" as const),
        };
      }
      if (spec.decision) {
        await tx.insert(contentReviews).values({
          postId,
          reviewerId: operatorId,
          decision: spec.decision,
          note,
          createdAt: nowBeijingWallTime(),
        });
      }
      if (action === "approve") {
        // 补发创建事件（pending 路径从未发过；作者首次获得积分入账）。
        enqueued.push(
          transition.kind === "thread"
            ? await enqueueEventInTx(
                tx,
                "thread.created",
                {
                  threadId: ctx.threadId,
                  postId,
                  forumId: ctx.forumId,
                  authorId: ctx.authorId,
                  title: ctx.title,
                },
                { actorId: ctx.authorId, source: "moderation" },
              )
            : await enqueueEventInTx(
                tx,
                "thread.replied",
                {
                  threadId: ctx.threadId,
                  postId,
                  forumId: ctx.forumId,
                  authorId: ctx.authorId,
                  threadAuthorId: (await threadAuthor(tx, ctx.threadId)) ?? ctx.authorId,
                },
                { actorId: ctx.authorId, source: "moderation" },
              ),
        );
      }
      enqueued.push(
        await enqueueEventInTx(
          tx,
          "content.moderated",
          { postId, operatorId, action, ...(action !== "approve" ? { reason: note } : {}) },
          { actorId: operatorId, source: "moderation" },
        ),
      );
      return { ok: true as const, enqueued };
    }, POINTS_TX_OPTIONS),
  );
  if (!result.ok) return { ok: false, code: result.code, message: "状态迁移失败" };
  await dispatchOutboxRows(result.enqueued);
  await sweepPending();
  return { ok: true };
}

/** 审核通过：pending → visible；写审核记录，补发创建事件与审核事件。 */
export async function approveReview(
  operator: Subject,
  postId: number,
  actor: ConfigActor,
): Promise<ReviewOutcome> {
  return runModerationAction("approve", operator, postId, actor);
}

/** 驳回：pending → rejected；理由必填，审核记录与审计同事务。 */
export async function rejectReview(
  operator: Subject,
  postId: number,
  reason: string,
  actor: ConfigActor,
): Promise<ReviewOutcome> {
  return runModerationAction("reject", operator, postId, actor, reason);
}

/** 屏蔽：visible → hidden；版主理由必填，不新增审核历史行。 */
export async function hidePost(
  operator: Subject,
  postId: number,
  reason: string,
  actor: ConfigActor,
): Promise<ReviewOutcome> {
  return runModerationAction("hide", operator, postId, actor, reason);
}

async function threadAuthor(tx: DbTx, threadId: number): Promise<number | null> {
  const [row] = await tx
    .select({ authorId: threads.authorId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  return row?.authorId ?? null;
}

export type ReviewTab = "pending" | "removed";

export type ReviewPageFilters = {
  tab: ReviewTab;
  /** 按板块筛选（仅所辖板块内的一个） */
  forumId?: number;
  /** 按类型筛选：主题首帖 / 回帖 */
  kind?: "thread" | "reply";
  page: number;
  perPage?: number;
};

export type ReviewQueueItem = {
  postId: number;
  threadId: number;
  forumId: number;
  forumName: string;
  isThread: boolean;
  title: string;
  /** 正文前 80 字（公开部分 bodyMd；门控隐藏内容天然不出现） */
  excerpt: string | null;
  authorId: number;
  authorName: string | null;
  createdAt: string;
};

/**
 * 审核队列/回收站统一分页查询（M9.5 重做）：SQL where（板块 IN 所辖 + 状态 + 类型筛选）+ COUNT，
 * 替代原「limit*4 拉取后内存过滤」——旧形态超过预取窗口的队列项永远不可见且无 total。
 * pending 按提交时间正序（先到先审），removed 按时间倒序（最新删隐在前）。
 */
export async function listReviewPage(
  operator: Subject,
  opts: ReviewPageFilters,
): Promise<{ items: ReviewQueueItem[]; total: number; page: number; totalPages: number }> {
  const { buildViewerScope } = await import("@/lib/queries/visibility");
  const scope = await buildViewerScope(operator);
  if (scope.moderated.length === 0) return { items: [], total: 0, page: 1, totalPages: 1 };
  const { forums } = await import("@funwind/db");

  const perPage = opts.perPage ?? 20;
  const conds = [
    opts.tab === "pending"
      ? eq(posts.state, "pending")
      : inArray(posts.state, ["hidden", "deleted"]),
    inArray(threads.forumId, scope.moderated),
  ];
  if (opts.forumId) conds.push(eq(threads.forumId, opts.forumId));
  if (opts.kind === "thread") conds.push(eq(threads.firstPostId, posts.id));
  if (opts.kind === "reply") conds.push(ne(threads.firstPostId, posts.id));
  const where = and(...conds);

  const listSelect = {
    postId: posts.id,
    threadId: threads.id,
    forumId: threads.forumId,
    forumName: forums.name,
    firstPostId: threads.firstPostId,
    title: threads.title,
    excerpt: sql<string | null>`SUBSTRING(${posts.bodyMd}, 1, 80)`,
    authorId: posts.authorId,
    authorName: publicUsername(users.username, users.state, users.id),
    createdAt: posts.createdAt,
  };

  const [countRow] = await getWebDb()
    .select({ total: sql<number>`COUNT(*)` })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(where);
  const total = Number(countRow?.total ?? 0);
  const { page, totalPages, offset } = pageBounds(total, opts.page, perPage);
  const rows = await getWebDb()
    .select(listSelect)
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .innerJoin(forums, eq(forums.id, threads.forumId))
    .leftJoin(users, eq(users.id, posts.authorId))
    .where(where)
    .orderBy(opts.tab === "pending" ? asc(posts.createdAt) : desc(posts.createdAt))
    .limit(perPage)
    .offset(offset);

  return {
    items: rows.map((r) => ({
      postId: r.postId,
      threadId: r.threadId,
      forumId: r.forumId,
      forumName: r.forumName,
      isThread: r.firstPostId === r.postId,
      title: r.title,
      excerpt: r.excerpt,
      authorId: r.authorId,
      authorName: r.authorName,
      createdAt: r.createdAt,
    })),
    total,
    page,
    totalPages,
  };
}

/**
 * 内容封禁：→ disabled（M9.5 新增终态，§9.2-B）。
 * 作者可见标题与理由但不可编辑、不可重审；版主只能再将其彻底删除。
 */
export async function disableContent(
  operator: Subject,
  postId: number,
  reason: string,
  actor: ConfigActor,
): Promise<ReviewOutcome> {
  return runModerationAction("disable", operator, postId, actor, reason);
}

/** 审核历史（作者与版主可见）：content_reviews 全量行倒序（M9.5 §9.2-G1） */
export async function listContentReviews(
  postId: number,
): Promise<
  { id: number; decision: string; note: string; reviewerName: string | null; createdAt: string }[]
> {
  return getWebDb()
    .select({
      id: contentReviews.id,
      decision: contentReviews.decision,
      note: contentReviews.note,
      reviewerName: publicUsername(users.username, users.state, users.id),
      createdAt: contentReviews.createdAt,
    })
    .from(contentReviews)
    .leftJoin(users, eq(users.id, contentReviews.reviewerId))
    .where(eq(contentReviews.postId, postId))
    .orderBy(desc(contentReviews.id));
}
