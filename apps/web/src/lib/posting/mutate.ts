import { and, eq, ne, sql } from "drizzle-orm";
import { getWebDb, posts, threads } from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import { evaluate } from "@/lib/authz/evaluator";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import type { Subject } from "@/lib/authz/types";
import { applyGateDrafts } from "@/lib/gates/write";
import { limitsFor } from "@/lib/limits/load";
import { POINTS_TX_OPTIONS } from "@/lib/points/retry";
import { emit } from "@/modules/kernel/bus";
import type { EventName } from "@/modules/kernel/types";
import { transitionContent } from "./transition";
import { lockForum, lockThread, lockUserStats } from "./locks";
import {
  canDelete,
  canEdit,
  canRestore,
  type ActorFacts,
  type DenyCode,
  type RuleDecision,
  type TargetFacts,
} from "./rules";
import { checkReason, checkTitle } from "./text";
import {
  Rollback,
  err,
  gatePermissions,
  isError,
  prepareBody,
  withPostingRetry,
  type PostingError,
  type PostingErrorCode,
} from "./service";

/**
 * 编辑、删除、恢复（M6.1 第 5 步，设计稿 §5.2）。
 *
 * 加锁顺序与发帖一致：作者统计行 → 主题 → 帖子 → 版块。权限与限制在事务外取快照；事务内持锁后重读帖子与主题，
 * 再用同一份快照做判定（纯函数，不借第二条连接）。删除与恢复复用 transitionContent，计数与指针只由它负责。
 */

export type MutateErrorCode = PostingErrorCode;

export interface EditInput {
  postId: number;
  /** 完整源码（含门控围栏） */
  source: string;
  /** 首帖（主题）编辑时必填：新的标题；回帖忽略 */
  title?: string;
  /** 渲染编辑表单时看到的 edited_at（从未编辑为 null）；不一致即冲突，不静默覆盖 */
  expectedEditedAt: string | null;
  /** 版主编辑别人的内容时必填 */
  reason?: string;
}

export interface EditOk {
  ok: true;
  postId: number;
  threadId: number;
  state: "visible" | "pending";
  /** rejected 被作者修改后重新提交（转为 pending） */
  resubmitted: boolean;
  /** 保存后的标题（仅首帖编辑有意义，回帖为 null） */
  title: string | null;
  kind: "thread" | "reply";
}

export interface DeleteInput {
  postId: number;
  /** 版主删除别人的内容时必填 */
  reason?: string;
}

export interface DeleteOk {
  ok: true;
  postId: number;
  threadId: number;
  kind: "thread" | "reply";
}

export interface RestoreInput {
  postId: number;
  reason: string;
}

export interface RestoreOk {
  ok: true;
  postId: number;
  threadId: number;
  kind: "thread" | "reply";
}

export type MutateResult<T> = (T & { ok: true }) | PostingError;

export interface MutateDeps {
  /** 事件派发（单测注入；缺省走内核总线） */
  emitter?: (name: EventName, payload: never) => Promise<unknown>;
}

const defaultEmitter: NonNullable<MutateDeps["emitter"]> = (name, payload) =>
  emit(name, payload, { source: "posting" });

/** 事件派发：提交之后做，失败只记日志（与发帖一致） */
async function notify(deps: MutateDeps, name: EventName, payload: unknown): Promise<void> {
  try {
    await (deps.emitter ?? defaultEmitter)(name, payload as never);
  } catch (e) {
    console.error(`[posting] ${name} 派发失败（操作已提交）:`, e);
  }
}

/** 规则的拒绝码 → 服务层错误码，并附上对用户说明的文案（不含内部判定细节） */
const DENY_MESSAGE: Record<DenyCode, string> = {
  forbidden: "你没有权限执行这个操作",
  already_deleted: "该内容已被删除",
  thread_gone: "所属主题已被隐藏或删除",
  bad_state: "当前状态下不能执行这个操作",
  has_replies: "主题已有其他人的回复，作者不能删除（可请版主处理）",
  not_restorable: "只能恢复已删除或已隐藏的内容",
  edit_window_closed: "已超出编辑时限",
};
const rejectOf = (d: Extract<RuleDecision, { allowed: false }>): PostingError =>
  err(d.code as PostingErrorCode, DENY_MESSAGE[d.code]);

/** 探测：不加锁，只为知道要锁谁，以及事务外的权限判断 */
async function probe(postId: number) {
  const [row] = await getWebDb()
    .select({
      postId: posts.id,
      threadId: posts.threadId,
      authorId: posts.authorId,
      forumId: threads.forumId,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(eq(posts.id, postId));
  return row ?? null;
}

/** 锁后的帖子事实（已持锁，读到的是最新值） */
async function readTarget(tx: DbTx, postId: number, threadId: number, forumId: number) {
  const [p] = await tx
    .select({
      id: posts.id,
      floor: posts.floor,
      authorId: posts.authorId,
      state: posts.state,
      editedAt: posts.editedAt,
      ageSec: sql<number>`TIMESTAMPDIFF(SECOND, ${posts.createdAt}, NOW())`,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .for("update");
  const [t] = await tx
    .select({
      id: threads.id,
      forumId: threads.forumId,
      authorId: threads.authorId,
      state: threads.state,
      title: threads.title,
      firstPostId: threads.firstPostId,
      isLocked: threads.isLocked,
    })
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!p || !t) return null;
  // 锁前的探测用的 forumId 锁后必须仍然成立（主题可能被移动）；不成立则判断全部过期
  if (t.forumId !== forumId) return "conflict" as const;
  const kind: "thread" | "reply" = t.firstPostId === p.id ? "thread" : "reply";
  // 别人的可见回帖数（删除主题的判据）：不算作者自己的回帖
  const [others] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(posts)
    .where(
      and(
        eq(posts.threadId, threadId),
        eq(posts.state, "visible"),
        ne(posts.authorId, t.authorId),
        sql`${posts.floor} > 1`,
      ),
    );
  return { p, t, kind, othersVisibleReplies: Number(others?.n ?? 0) };
}

function facts(
  viewer: Subject,
  kind: "thread" | "reply",
  p: { authorId: number; state: string; ageSec: number },
  t: { state: string },
  othersVisibleReplies: number,
): { actor: ActorFacts; target: TargetFacts } {
  return {
    actor: { userId: viewer.userId!, isModerator: false, canWrite: true },
    target: {
      kind,
      authorId: p.authorId,
      state: p.state as TargetFacts["state"],
      threadState: t.state as TargetFacts["threadState"],
      othersVisibleReplies,
      ageSec: Number(p.ageSec),
    },
  };
}

export async function editPost(
  viewer: Subject,
  input: EditInput,
  deps: MutateDeps = {},
): Promise<MutateResult<EditOk>> {
  if (viewer.userId === null) return err("forbidden", "请先登录");
  const hit = await probe(input.postId);
  if (!hit) return err("not_found", "帖子不存在");
  const snap = await getAuthzSnapshot();
  const { forumId } = hit;
  const isModerator = evaluate(viewer, "forum.moderate", { forumId }, snap).allowed;
  const canWrite = evaluate(viewer, "forum.write", { forumId }, snap).allowed;
  const limits = await limitsFor(viewer, forumId);
  const body = prepareBody(input.source, limits.bodyMax);
  if (isError(body)) return body;
  const perms = gatePermissions(viewer, forumId, snap);

  try {
    const out = await withPostingRetry(() =>
      getWebDb().transaction(async (tx): Promise<EditOk> => {
        await lockUserStats(tx, hit.authorId);
        await lockThread(tx, hit.threadId);
        await lockForum(tx, forumId);
        const target = await readTarget(tx, hit.postId, hit.threadId, forumId);
        if (target === null) throw new Rollback(err("not_found", "帖子不存在"));
        if (target === "conflict")
          throw new Rollback(err("conflict", "主题已被移动，请刷新后重试"));
        const { p, t, kind, othersVisibleReplies } = target;

        // 编辑冲突：渲染表单时看到的版本必须仍是当前版本
        const current = p.editedAt ?? null;
        if (current !== input.expectedEditedAt) {
          throw new Rollback(err("conflict", "这条内容已被他人修改，请刷新后再编辑"));
        }

        const f = facts(viewer, kind, p, t, othersVisibleReplies);
        f.actor = { ...f.actor, isModerator, canWrite };
        const decision = canEdit(f.actor, f.target, limits.editWindowSec);
        if (!decision.allowed) throw new Rollback(rejectOf(decision));
        let reason: string | null = null;
        if (decision.reasonRequired) {
          const r = checkReason(input.reason ?? "");
          if (!r.ok) throw new Rollback(err(r.code, r.message));
          reason = r.value;
        }

        // 主题的标题与首帖一起改
        let title = t.title;
        if (kind === "thread") {
          const checked = checkTitle(input.title ?? t.title, limits.titleMax);
          if (!checked.ok) throw new Rollback(err(checked.code, checked.message));
          title = checked.value;
        }

        // 门控对账：已有解锁记录的门控只能改价，不能换方式、删除或挂着附件时删除
        const gateRes = await applyGateDrafts(tx, hit.postId, body.gates, perms);
        if (!gateRes.ok) throw new Rollback(err(gateRes.error.code, gateRes.error.message));

        const resubmit = decision.resubmit;
        const nextState = resubmit ? "pending" : (p.state as "visible" | "pending");
        await tx
          .update(posts)
          .set({
            bodyMd: body.publicMd,
            hasGate: gateRes.gateCount > 0,
            editedAt: sql`NOW()`,
            state: nextState,
          })
          .where(eq(posts.id, hit.postId));
        if (kind === "thread") {
          await tx
            .update(threads)
            .set({ title, ...(resubmit ? { state: nextState } : {}) })
            .where(eq(threads.id, hit.threadId));
        }
        // 待审 / 驳回之间的互转不改变计数（两者都不可见），这里不需要 applyCounterDelta

        if (viewer.userId !== hit.authorId) {
          await writeAudit(tx, {
            actorId: viewer.userId,
            action: "post.edit",
            targetType: "post",
            targetId: hit.postId,
            after: { threadId: hit.threadId, kind, reason },
          });
        }
        return {
          ok: true,
          postId: hit.postId,
          threadId: hit.threadId,
          state: nextState,
          resubmitted: resubmit,
          title: kind === "thread" ? title : null,
          kind,
        };
      }, POINTS_TX_OPTIONS),
    );
    const isThread = out.kind === "thread";
    if (out.resubmitted) {
      await notify(deps, "content.submitted", {
        postId: out.postId,
        threadId: out.threadId,
        authorId: hit.authorId,
        forumId,
        isThread,
      });
    } else if (out.state === "visible") {
      await notify(
        deps,
        isThread ? "thread.edited" : "post.edited",
        isThread
          ? {
              threadId: out.threadId,
              postId: out.postId,
              forumId,
              authorId: hit.authorId,
              editorId: viewer.userId,
              title: out.title ?? "",
            }
          : {
              postId: out.postId,
              threadId: out.threadId,
              forumId,
              authorId: hit.authorId,
              editorId: viewer.userId,
            },
      );
    }
    return out;
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
}

export async function deletePost(
  viewer: Subject,
  input: DeleteInput,
  deps: MutateDeps = {},
): Promise<MutateResult<DeleteOk>> {
  if (viewer.userId === null) return err("forbidden", "请先登录");
  const hit = await probe(input.postId);
  if (!hit) return err("not_found", "帖子不存在");
  const snap = await getAuthzSnapshot();
  const { forumId } = hit;
  const isModerator = evaluate(viewer, "forum.moderate", { forumId }, snap).allowed;
  const canWrite = evaluate(viewer, "forum.write", { forumId }, snap).allowed;

  try {
    const out = await withPostingRetry(() =>
      getWebDb().transaction(async (tx): Promise<DeleteOk> => {
        await lockUserStats(tx, hit.authorId);
        await lockThread(tx, hit.threadId);
        await lockForum(tx, forumId);
        const target = await readTarget(tx, hit.postId, hit.threadId, forumId);
        if (target === null) throw new Rollback(err("not_found", "帖子不存在"));
        if (target === "conflict")
          throw new Rollback(err("conflict", "主题已被移动，请刷新后重试"));
        const { p, t, kind, othersVisibleReplies } = target;

        const f = facts(viewer, kind, p, t, othersVisibleReplies);
        f.actor = { ...f.actor, isModerator, canWrite };
        const decision = canDelete(f.actor, f.target);
        if (!decision.allowed) throw new Rollback(rejectOf(decision));
        let reason: string | null = null;
        if (decision.reasonRequired) {
          const r = checkReason(input.reason ?? "");
          if (!r.ok) throw new Rollback(err(r.code, r.message));
          reason = r.value;
        }

        // 状态迁移（计数与指针由 transitionContent 负责）。版主操作写审计，作者删自己的不写
        await transitionContent(tx, hit.postId, "deleted", {
          actorId: viewer.userId,
          reason: reason ?? undefined,
          audit: decision.reasonRequired,
        });
        return { ok: true, postId: hit.postId, threadId: hit.threadId, kind };
      }, POINTS_TX_OPTIONS),
    );
    const byModerator = viewer.userId !== hit.authorId;
    await notify(
      deps,
      out.kind === "thread" ? "thread.deleted" : "post.deleted",
      out.kind === "thread"
        ? {
            threadId: out.threadId,
            postId: out.postId,
            forumId,
            authorId: hit.authorId,
            operatorId: viewer.userId,
            byModerator,
          }
        : {
            postId: out.postId,
            threadId: out.threadId,
            forumId,
            authorId: hit.authorId,
            operatorId: viewer.userId,
            byModerator,
          },
    );
    return out;
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
}

export async function restorePost(
  viewer: Subject,
  input: RestoreInput,
  deps: MutateDeps = {},
): Promise<MutateResult<RestoreOk>> {
  if (viewer.userId === null) return err("forbidden", "请先登录");
  const hit = await probe(input.postId);
  if (!hit) return err("not_found", "帖子不存在");
  const snap = await getAuthzSnapshot();
  const { forumId } = hit;
  const isModerator = evaluate(viewer, "forum.moderate", { forumId }, snap).allowed;

  try {
    const out = await withPostingRetry(() =>
      getWebDb().transaction(async (tx): Promise<RestoreOk> => {
        await lockUserStats(tx, hit.authorId);
        await lockThread(tx, hit.threadId);
        await lockForum(tx, forumId);
        const target = await readTarget(tx, hit.postId, hit.threadId, forumId);
        if (target === null) throw new Rollback(err("not_found", "帖子不存在"));
        if (target === "conflict")
          throw new Rollback(err("conflict", "主题已被移动，请刷新后重试"));
        const { p, t, kind, othersVisibleReplies } = target;

        const f = facts(viewer, kind, p, t, othersVisibleReplies);
        f.actor = { ...f.actor, isModerator };
        const decision = canRestore(f.actor, f.target);
        if (!decision.allowed) {
          throw new Rollback(
            decision.code === "not_restorable"
              ? err("not_restorable", DENY_MESSAGE.not_restorable)
              : rejectOf(decision),
          );
        }
        const r = checkReason(input.reason);
        if (!r.ok) throw new Rollback(err(r.code, r.message));

        await transitionContent(tx, hit.postId, "visible", {
          actorId: viewer.userId,
          reason: r.value,
          audit: true,
        });
        return { ok: true, postId: hit.postId, threadId: hit.threadId, kind };
      }, POINTS_TX_OPTIONS),
    );
    await notify(deps, "content.moderated", {
      postId: out.postId,
      operatorId: viewer.userId,
      action: "restore",
      reason: input.reason,
    });
    return out;
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
}
