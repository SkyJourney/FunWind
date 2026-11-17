import { and, desc, eq } from "drizzle-orm";
import { contentReviews, getWebDb, posts, threads, users } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { nowBeijingWallTime } from "@/lib/datetime";
import { transitionContent } from "@/lib/posting/transition";
import { lockForum, lockThread } from "@/lib/posting/locks";
import { lockUserStats } from "@/lib/locks";
import { checkPermission } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";
import { publicUsername } from "@/lib/identity-expr";
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
      // 沿用迁移入口的锁序；同一事务内重验动作前置状态，不能把恢复白名单当成审核通过。
      await lockUserStats(tx, ctx.authorId);
      const lockedThread = await lockThread(tx, ctx.threadId);
      const [lockedPost] = await tx
        .select({ state: posts.state, replyToPostId: posts.replyToPostId })
        .from(posts)
        .where(eq(posts.id, postId))
        .for("update");
      if (!lockedThread || !lockedPost) {
        return {
          ok: false as const,
          code: action === "approve" ? ("not_found" as const) : ("bad_state" as const),
        };
      }
      await lockForum(tx, lockedThread.forumId);
      if (spec.stateError(lockedPost.state)) {
        return { ok: false as const, code: "bad_state" as const };
      }
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
        const [replyTarget] =
          transition.kind === "reply" && lockedPost.replyToPostId !== null
            ? await tx
                .select({ authorId: posts.authorId })
                .from(posts)
                .where(
                  and(eq(posts.id, lockedPost.replyToPostId), eq(posts.threadId, ctx.threadId)),
                )
                .limit(1)
            : [];
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
                  threadAuthorId: transition.threadAuthorId,
                  ...(lockedPost.replyToPostId !== null && replyTarget
                    ? {
                        replyToPostId: lockedPost.replyToPostId,
                        replyToAuthorId: replyTarget.authorId,
                      }
                    : {}),
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

/**
 * 内容封禁：→ disabled（M9.5 新增终态，§9.2-B）。
 * 作者可见标题与理由但不可编辑、不可重审；版主只能再将其彻底删除（M19 起入口在 /admin/contents）。
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
