import { and, desc, eq } from "drizzle-orm";
import { contentReviews, getWebDb, posts, threads, users } from "@funwind/db";
import type { ConfigActor, DbTx } from "@/lib/audit";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { nowBeijingWallTime } from "@/lib/datetime";
import { transitionContent } from "@/lib/posting/transition";
import { checkPermission } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";
import { publicUsername } from "@/lib/identity-expr";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";
import { MODERATION_NOTIFICATION_DELIVERY_POLICY } from "@/modules/kernel/types";
import {
  loadPostContext,
  lockModerationTarget,
  type ModerationApiTrace,
  type ModerationWriteDenial,
  type PreparedModerationWrite,
} from "./contents";

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

/** 版主权限：帖子所在版块的 forum.moderate */
async function canModerate(operator: Subject, forumId: number): Promise<boolean> {
  return (await checkPermission(operator, "forum.moderate", { forumId })).allowed;
}

/** 理由校验（trim 后 1–255）；只产生 reason_required / reason_too_long 两码 */
const checkReason = (
  reason: string,
): { ok: true } | { ok: false; code: "reason_required" | "reason_too_long"; message: string } => {
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

type LockedReviewTarget = NonNullable<Awaited<ReturnType<typeof lockModerationTarget>>>;

/** 两个入口共用真实变更；任何重试的事件只随本次事务结果交给提交后快派。 */
async function executeModeration(
  tx: DbTx,
  postId: number,
  target: LockedReviewTarget,
  action: ModerationAction,
  operatorId: number,
  actor: ConfigActor,
  note: string,
  api?: { expectedEditedAt: string | null; trace: ModerationApiTrace },
) {
  const { post } = target;
  const spec = MODERATION_ACTIONS[action];
  const stateError = spec.stateError(post.state);
  if (stateError) return { ok: false as const, code: "bad_state" as const, message: stateError };
  if (api && post.editedAt !== api.expectedEditedAt) {
    return { ok: false as const, code: "conflict" as const, message: "内容已编辑，请刷新后再审核" };
  }
  if (!target.hasStats) {
    throw new Error(`用户 ${post.authorId} 缺少统计行，拒绝迁移；请先 db:recount`);
  }
  const enqueued: EnqueuedEvent[] = [];
  const transition = await transitionContent(tx, postId, spec.to, {
    actorId: operatorId,
    ip: actor.ip,
    audit: true,
    ...(action !== "approve" ? { reason: note } : {}),
    ...(action === "disable" ? { actor: "moderator" as const } : {}),
    ...(api ? { apiTrace: api.trace } : {}),
  });
  if (!transition.ok) {
    return {
      ok: false as const,
      code: transition.code === "not_found" ? ("not_found" as const) : ("bad_state" as const),
      message: "状态迁移失败",
    };
  }
  const { threadId, forumId, authorId } = transition;
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
    // 补发创建事件（待审路径未发过；作者首次获得积分入账）。
    const source = { actorId: authorId, source: "moderation" };
    if (transition.kind === "thread") {
      const [thread] = await tx
        .select({ title: threads.title })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      enqueued.push(
        await enqueueEventInTx(
          tx,
          "thread.created",
          { threadId, postId, forumId, authorId, title: thread!.title },
          source,
        ),
      );
    } else {
      const [replyTarget] =
        post.replyToPostId !== null
          ? await tx
              .select({ authorId: posts.authorId })
              .from(posts)
              .where(and(eq(posts.id, post.replyToPostId), eq(posts.threadId, threadId)))
              .limit(1)
          : [];
      enqueued.push(
        await enqueueEventInTx(
          tx,
          "thread.replied",
          {
            threadId,
            postId,
            forumId,
            authorId,
            threadAuthorId: transition.threadAuthorId,
            ...(post.replyToPostId !== null && replyTarget
              ? { replyToPostId: post.replyToPostId, replyToAuthorId: replyTarget.authorId }
              : {}),
          },
          { ...source, deliveryPolicy: MODERATION_NOTIFICATION_DELIVERY_POLICY },
        ),
      );
    }
  }
  enqueued.push(
    await enqueueEventInTx(
      tx,
      "content.moderated",
      { postId, operatorId, action, ...(action !== "approve" ? { reason: note } : {}) },
      {
        actorId: operatorId,
        source: "moderation",
        deliveryPolicy:
          action === "approve" || action === "reject"
            ? MODERATION_NOTIFICATION_DELIVERY_POLICY
            : undefined,
      },
    ),
  );
  return {
    ok: true as const,
    threadId,
    async afterCommit() {
      await dispatchOutboxRows(enqueued);
      await sweepPending();
    },
  };
}

/** 原后台先鉴权、再状态、后理由，保留各动作对锁内失败的错误映射。 */
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
  const stateError = MODERATION_ACTIONS[action].stateError(ctx.postState);
  if (stateError) return { ok: false, code: "bad_state", message: stateError };
  if (action !== "approve") {
    const reasonCheck = checkReason(reason!);
    if (!reasonCheck.ok) return reasonCheck;
  }
  const note = action === "approve" ? "" : reason!.trim();

  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const target = await lockModerationTarget(tx, postId, ctx);
      return target
        ? executeModeration(tx, postId, target, action, operatorId, actor, note)
        : { ok: false as const, code: "not_found" as const };
    }, POINTS_TX_OPTIONS),
  );
  if (!result.ok) {
    const code = action === "approve" && result.code === "not_found" ? "not_found" : "bad_state";
    return { ok: false, code, message: "状态迁移失败" };
  }
  await result.afterCommit();
  return { ok: true };
}

type ApiReviewInput = {
  decision: ModerationAction;
  expectedEditedAt: string | null;
  reason?: string;
};
type ApiReviewState = "visible" | "rejected" | "hidden" | "disabled";
type ApiReviewData = { postId: number; threadId: number; state: ApiReviewState };
type ApiReviewCode = "not_found" | "bad_state" | "conflict";
type PreparedApiReview = PreparedModerationWrite<ApiReviewData, ApiReviewCode>;

/**
 * 事务外鉴权；锁定只确认目标范围，审核前置条件（状态、版本）留到无回放的实际执行阶段。
 * 四态 decision 全部经 runModerationAction 同一套 MODERATION_ACTIONS（状态机、content_reviews、
 * outbox 与后台一致）；hide/disable 与后台同口径要求理由（trim 后 1–255），在事务外先拒。
 */
export async function prepareApiReview(
  subject: Subject,
  postId: number,
  input: ApiReviewInput,
  actor: ConfigActor,
  trace: ModerationApiTrace,
): Promise<
  PreparedApiReview | ModerationWriteDenial<"not_found" | "reason_required" | "reason_too_long">
> {
  const notFound = { ok: false as const, code: "not_found" as const, message: "帖子不存在" };
  if (subject.userId === null) return notFound;
  const operatorId = subject.userId;
  const ctx = await loadPostContext(postId);
  if (!ctx || !(await canModerate(subject, ctx.forumId))) return notFound;
  const { decision, expectedEditedAt } = input;
  if (decision === "hide" || decision === "disable") {
    const reasonCheck = checkReason(input.reason ?? "");
    if (!reasonCheck.ok) return reasonCheck;
  }
  const note = decision === "approve" ? "" : (input.reason?.trim() ?? "");
  return {
    ok: true,
    async lock(tx) {
      const target = await lockModerationTarget(tx, postId, ctx, subject);
      if (!target) return notFound;
      return {
        ok: true,
        async execute() {
          const result = await executeModeration(
            tx,
            postId,
            target,
            decision,
            operatorId,
            actor,
            note,
            {
              expectedEditedAt,
              trace,
            },
          );
          if (!result.ok) return result.code === "not_found" ? notFound : result;
          return {
            ok: true,
            data: {
              postId,
              threadId: result.threadId,
              state: MODERATION_ACTIONS[decision].to,
            },
            afterCommit: result.afterCommit,
          };
        },
      };
    },
  };
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
