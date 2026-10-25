import { eq, inArray, sql } from "drizzle-orm";
import { contentReviews, getWebDb, posts, threads, users } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { transitionContent } from "@/lib/posting/transition";
import { checkPermission } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";

/**
 * 内容审核动作（M9，docs/milestones/M9-admin.md §2）：approve / reject / hide。
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

/** 审核通过：pending → visible；写 content_reviews(approved)；补发 thread.created/thread.replied + content.moderated */
export async function approveReview(
  operator: Subject,
  postId: number,
  actor: ConfigActor,
): Promise<ReviewOutcome> {
  if (operator.userId === null) return { ok: false, code: "forbidden", message: "请先登录" };
  const operatorId = operator.userId;
  const ctx = await loadPostContext(postId);
  if (!ctx) return { ok: false, code: "not_found", message: "帖子不存在" };
  if (!(await canModerate(operator, ctx.forumId))) {
    return { ok: false, code: "forbidden", message: "你不是该版块的版主" };
  }
  if (ctx.postState !== "pending") {
    return {
      ok: false,
      code: "bad_state",
      message: `当前状态是 ${ctx.postState}，只有待审内容可以通过`,
    };
  }

  const enqueued: EnqueuedEvent[] = [];
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const transition = await transitionContent(tx, postId, "visible", {
        actorId: operatorId,
        ip: actor.ip,
        audit: true,
      });
      if (!transition.ok) return transition.code === "not_found" ? "not_found" : "bad_state";

      await tx.insert(contentReviews).values({
        postId,
        reviewerId: operatorId,
        decision: "approved",
        note: "",
        createdAt: sql`NOW()`,
      });

      // 补发创建事件（pending 路径从未发过；作者首次获得积分入账）
      if (transition.kind === "thread") {
        enqueued.push(
          await enqueueEventInTx(
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
          ),
        );
      } else {
        enqueued.push(
          await enqueueEventInTx(
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
          { postId, operatorId: operatorId, action: "approve" },
          { actorId: operatorId, source: "moderation" },
        ),
      );
      return null;
    }, POINTS_TX_OPTIONS),
  );
  if (result !== null) {
    return {
      ok: false,
      code: result === "not_found" ? "not_found" : "bad_state",
      message: "状态迁移失败",
    };
  }
  await dispatchOutboxRows(enqueued);
  await sweepPending();
  return { ok: true };
}

/** 驳回：pending → rejected；理由必填，写 content_reviews(rejected, note) 与审计 */
export async function rejectReview(
  operator: Subject,
  postId: number,
  reason: string,
  actor: ConfigActor,
): Promise<ReviewOutcome> {
  if (operator.userId === null) return { ok: false, code: "forbidden", message: "请先登录" };
  const operatorId = operator.userId;
  const ctx = await loadPostContext(postId);
  if (!ctx) return { ok: false, code: "not_found", message: "帖子不存在" };
  if (!(await canModerate(operator, ctx.forumId))) {
    return { ok: false, code: "forbidden", message: "你不是该版块的版主" };
  }
  if (ctx.postState !== "pending") {
    return {
      ok: false,
      code: "bad_state",
      message: `当前状态是 ${ctx.postState}，只有待审内容可以驳回`,
    };
  }
  const reasonCheck = checkReason(reason);
  if (!reasonCheck.ok) return { ok: false, code: reasonCheck.code, message: reasonCheck.message };

  const enqueued: EnqueuedEvent[] = [];
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const transition = await transitionContent(tx, postId, "rejected", {
        actorId: operatorId,
        ip: actor.ip,
        reason: reason.trim(),
        audit: true,
      });
      if (!transition.ok) return "bad_state";

      await tx.insert(contentReviews).values({
        postId,
        reviewerId: operatorId,
        decision: "rejected",
        note: reason.trim(),
        createdAt: sql`NOW()`,
      });
      enqueued.push(
        await enqueueEventInTx(
          tx,
          "content.moderated",
          { postId, operatorId: operatorId, action: "reject", reason: reason.trim() },
          { actorId: operatorId, source: "moderation" },
        ),
      );
      return null;
    }, POINTS_TX_OPTIONS),
  );
  if (result !== null) return { ok: false, code: "bad_state", message: "状态迁移失败" };
  await dispatchOutboxRows(enqueued);
  await sweepPending();
  return { ok: true };
}

/** 屏蔽：visible → hidden（版主理由必填）——M6 以来 hidden 的第一个写入口 */
export async function hidePost(
  operator: Subject,
  postId: number,
  reason: string,
  actor: ConfigActor,
): Promise<ReviewOutcome> {
  if (operator.userId === null) return { ok: false, code: "forbidden", message: "请先登录" };
  const operatorId = operator.userId;
  const ctx = await loadPostContext(postId);
  if (!ctx) return { ok: false, code: "not_found", message: "帖子不存在" };
  if (!(await canModerate(operator, ctx.forumId))) {
    return { ok: false, code: "forbidden", message: "你不是该版块的版主" };
  }
  if (ctx.postState !== "visible") {
    return {
      ok: false,
      code: "bad_state",
      message: `当前状态是 ${ctx.postState}，只有可见内容可以屏蔽`,
    };
  }
  const reasonCheck = checkReason(reason);
  if (!reasonCheck.ok) return { ok: false, code: reasonCheck.code, message: reasonCheck.message };

  const enqueued: EnqueuedEvent[] = [];
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const transition = await transitionContent(tx, postId, "hidden", {
        actorId: operatorId,
        ip: actor.ip,
        reason: reason.trim(),
        audit: true,
      });
      if (!transition.ok) return "bad_state";
      enqueued.push(
        await enqueueEventInTx(
          tx,
          "content.moderated",
          { postId, operatorId: operatorId, action: "hide", reason: reason.trim() },
          { actorId: operatorId, source: "moderation" },
        ),
      );
      return null;
    }, POINTS_TX_OPTIONS),
  );
  if (result !== null) return { ok: false, code: "bad_state", message: "状态迁移失败" };
  await dispatchOutboxRows(enqueued);
  await sweepPending();
  return { ok: true };
}

async function threadAuthor(
  tx: Parameters<Parameters<ReturnType<typeof getWebDb>["transaction"]>[0]>[0],
  threadId: number,
): Promise<number | null> {
  const [row] = await tx
    .select({ authorId: threads.authorId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  return row?.authorId ?? null;
}

/** 审核队列：某主体的待审内容（所辖版块 ∩ pending；主题与回帖都列，按提交时间升序） */
export interface ReviewQueueItem {
  postId: number;
  threadId: number;
  forumId: number;
  forumName: string;
  isThread: boolean;
  title: string;
  authorId: number;
  authorName: string | null;
  createdAt: string;
}

export async function reviewQueue(operator: Subject, limit = 50): Promise<ReviewQueueItem[]> {
  const { buildViewerScope } = await import("@/lib/queries/visibility");
  const scope = await buildViewerScope(operator);
  if (scope.moderated.length === 0) return [];
  const { forums } = await import("@funwind/db");

  const rows = await getWebDb()
    .select({
      postId: posts.id,
      threadId: threads.id,
      forumId: threads.forumId,
      forumName: forums.name,
      firstPostId: threads.firstPostId,
      title: threads.title,
      authorId: posts.authorId,
      authorName: users.username,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .innerJoin(forums, eq(forums.id, threads.forumId))
    .leftJoin(users, eq(users.id, posts.authorId))
    .where(eq(posts.state, "pending"))
    .orderBy(posts.createdAt)
    .limit(limit * 4);
  // 版块过滤在应用层（moderated 数组小；SQL IN + 版块 id 对齐也行，这里保持与 visiblePredicate 同源的 scope）
  return rows
    .filter((r) => scope.moderated.includes(r.forumId))
    .slice(0, limit)
    .map((r) => ({
      postId: r.postId,
      threadId: r.threadId,
      forumId: r.forumId,
      forumName: r.forumName,
      isThread: r.firstPostId === r.postId,
      title: r.title,
      authorId: r.authorId,
      authorName: r.authorName,
      createdAt: r.createdAt,
    }));
}

/** 已删隐内容（回收站 tab）：所辖版块内 state ∈ {hidden, deleted}，按时间降序 */
export async function removedContent(operator: Subject, limit = 50): Promise<ReviewQueueItem[]> {
  const { buildViewerScope } = await import("@/lib/queries/visibility");
  const scope = await buildViewerScope(operator);
  if (scope.moderated.length === 0) return [];
  const { forums } = await import("@funwind/db");

  const rows = await getWebDb()
    .select({
      postId: posts.id,
      threadId: threads.id,
      forumId: threads.forumId,
      forumName: forums.name,
      firstPostId: threads.firstPostId,
      title: threads.title,
      authorId: posts.authorId,
      authorName: users.username,
      state: posts.state,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .innerJoin(forums, eq(forums.id, threads.forumId))
    .leftJoin(users, eq(users.id, posts.authorId))
    .where(inArray(posts.state, ["hidden", "deleted"]))
    .orderBy(posts.createdAt)
    .limit(limit * 4);
  return rows
    .filter((r) => scope.moderated.includes(r.forumId))
    .slice(0, limit)
    .map((r) => ({
      postId: r.postId,
      threadId: r.threadId,
      forumId: r.forumId,
      forumName: r.forumName,
      isThread: r.firstPostId === r.postId,
      title: r.title,
      authorId: r.authorId,
      authorName: r.authorName,
      createdAt: r.createdAt,
    }));
}
