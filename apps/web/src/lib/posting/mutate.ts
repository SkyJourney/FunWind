import { and, desc, eq, ne, sql } from "drizzle-orm";
import { contentReviews, getWebDb, posts, threads } from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import { evaluate } from "@/lib/authz/evaluator";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { applyGateDrafts } from "@/lib/gates/write";
import {
  registerSourceFiles,
  type AttachmentInput,
  type UploadedAttachment,
} from "@/lib/gates/attachments";
import { extractKeys } from "@funwind/content";
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
  /** 下载附件的完整列表（提交即替换；缺省视为不变更附件由调用方传入现有列表） */
  attachments?: readonly AttachmentInput[];
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
  /** 所属版块：删除主题后页面跳回版块列表（主题页已不可见） */
  forumId: number;
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
      // 旧正文：编辑时用于例外集合（已被本帖引用的图片不重新校验归属）
      bodyMd: posts.bodyMd,
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

/** 只读判定所需的全部事实（不加锁；保存、删除、恢复时各自的写入口会在锁内重判） */
interface PostFacts {
  postId: number;
  threadId: number;
  forumId: number;
  kind: "thread" | "reply";
  authorId: number;
  /** 帖子自身状态 */
  state: string;
  /** 主题标题（首帖才有意义；回帖为空串） */
  title: string;
  /** 公开正文（含门控占位，不含隐藏正文） */
  bodyMd: string;
  hasGate: boolean;
  /** 渲染表单时看到的 edited_at，保存时作为 expectedEditedAt 回传（从未编辑为 null） */
  editedAt: string | null;
  actor: ActorFacts;
  target: TargetFacts;
}

/** 取判定所需的事实。不可见 / 不存在 / 游客 → null。调用方须自行确认帖子对观众可见（或只关心版主视角） */
async function loadPostFacts(viewer: Subject, postId: number): Promise<PostFacts | null> {
  if (viewer.userId === null) return null;
  const hit = await probe(postId);
  if (!hit) return null;
  const snap = await getAuthzSnapshot();
  const { forumId } = hit;
  const isModerator = evaluate(viewer, "forum.moderate", { forumId }, snap).allowed;
  const canWrite = evaluate(viewer, "forum.write", { forumId }, snap).allowed;

  const db = getWebDb();
  const [p] = await db
    .select({
      id: posts.id,
      floor: posts.floor,
      authorId: posts.authorId,
      state: posts.state,
      editedAt: posts.editedAt,
      bodyMd: posts.bodyMd,
      hasGate: posts.hasGate,
      ageSec: sql<number>`TIMESTAMPDIFF(SECOND, ${posts.createdAt}, NOW())`,
    })
    .from(posts)
    .where(eq(posts.id, postId));
  const [t] = await db
    .select({
      id: threads.id,
      forumId: threads.forumId,
      authorId: threads.authorId,
      state: threads.state,
      title: threads.title,
      firstPostId: threads.firstPostId,
    })
    .from(threads)
    .where(eq(threads.id, hit.threadId));
  if (!p || !t) return null;

  const kind: "thread" | "reply" = t.firstPostId === p.id ? "thread" : "reply";
  const [others] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(posts)
    .where(
      and(
        eq(posts.threadId, t.id),
        eq(posts.state, "visible"),
        ne(posts.authorId, t.authorId),
        sql`${posts.floor} > 1`,
      ),
    );
  const f = facts(viewer, kind, p, t, Number(others?.n ?? 0));
  f.actor = { ...f.actor, isModerator, canWrite };
  return {
    postId,
    threadId: t.id,
    forumId,
    kind,
    authorId: p.authorId,
    state: p.state,
    title: t.title,
    bodyMd: p.bodyMd ?? "",
    hasGate: p.hasGate,
    editedAt: p.editedAt ?? null,
    actor: f.actor,
    target: f.target,
  };
}

/** 最近一次驳回的理由（content_reviews）。没有理由或没有驳回记录 → null */
async function latestRejectNote(postId: number): Promise<string | null> {
  const [row] = await getWebDb()
    .select({ note: contentReviews.note })
    .from(contentReviews)
    .where(and(eq(contentReviews.postId, postId), eq(contentReviews.decision, "rejected")))
    .orderBy(desc(contentReviews.id))
    .limit(1);
  return row?.note ? row.note : null;
}

/**
 * 编辑页用的只读视图（不加锁）：判定观众能否编辑这条帖子，并给出表单需要的事实。
 * 保存时 editPost 仍会在锁内重新判定，这里的结论只决定页面怎么展示。调用方须已确认帖子对观众可见。
 */
export interface EditView {
  postId: number;
  threadId: number;
  forumId: number;
  kind: "thread" | "reply";
  bodyMd: string;
  hasGate: boolean;
  editedAt: string | null;
  title: string;
  decision: RuleDecision;
  /** 被驳回的帖子：最近一次驳回的理由（没有则 null） */
  reviewNote: string | null;
}

export async function readEditView(viewer: Subject, postId: number): Promise<EditView | null> {
  const f = await loadPostFacts(viewer, postId);
  if (!f) return null;
  const limits = await limitsFor(viewer, f.forumId);
  return {
    postId,
    threadId: f.threadId,
    forumId: f.forumId,
    kind: f.kind,
    bodyMd: f.bodyMd,
    hasGate: f.hasGate,
    editedAt: f.editedAt,
    title: f.title,
    decision: canEdit(f.actor, f.target, limits.editWindowSec),
    reviewNote: f.state === "rejected" ? await latestRejectNote(postId) : null,
  };
}

/**
 * 删除 / 恢复页用的只读视图（版主视角与作者视角都能算；不加锁，动作时在锁内重判）。
 * delete / restore 两个判定都给出，页面只展示其中一个。
 */
export interface ModerationView {
  postId: number;
  threadId: number;
  forumId: number;
  kind: "thread" | "reply";
  authorId: number;
  state: string;
  title: string;
  delete: RuleDecision;
  restore: RuleDecision;
}

export async function readModerationView(
  viewer: Subject,
  postId: number,
): Promise<ModerationView | null> {
  const f = await loadPostFacts(viewer, postId);
  if (!f) return null;
  return {
    postId,
    threadId: f.threadId,
    forumId: f.forumId,
    kind: f.kind,
    authorId: f.authorId,
    state: f.state,
    title: f.title,
    delete: canDelete(f.actor, f.target),
    restore: canRestore(f.actor, f.target),
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
  // 门控与附件的新增权限归帖子作者（docs/GATES.md）：版主替作者改帖时，不得借自己的权限给作者增加付费门控或附件
  const author = viewer.userId === hit.authorId ? viewer : await loadSubject(hit.authorId);
  // 上传权限在事务外算出（纯内存快照），登记新附件时使用
  const canUpload = evaluate(author, "attachment.upload", { forumId }, snap).allowed;
  const limits = await limitsFor(viewer, forumId);
  const body = prepareBody(input.source, limits.bodyMax);
  if (isError(body)) return body;
  const perms = gatePermissions(author, forumId, snap);
  let uploads: UploadedAttachment[] = [];

  try {
    const out = await withPostingRetry(() =>
      getWebDb().transaction(async (tx): Promise<EditOk> => {
        await lockUserStats(tx, hit.authorId);
        await lockThread(tx, hit.threadId);
        // 纯编辑不改版块计数，不取版块锁；状态迁移（transitionContent）会自己按需取版块锁。
        // 主题是否被移动由持主题锁后的 readTarget 判定
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
        // 旧正文里的引用不重新校验归属（迁移来的旧图在作者编辑时不得被误拒）
        const reg = await registerSourceFiles(tx, {
          postId: hit.postId,
          authorId: hit.authorId,
          source: body.body,
          attachments: input.attachments,
          priorRefs: new Set(extractKeys(p.bodyMd ?? "")),
          canUpload,
        });
        if (!reg.ok) throw new Rollback(err(reg.code, reg.message));
        uploads = reg.uploaded;

        const resubmit = decision.resubmit;
        const nextState = resubmit ? "pending" : (p.state as "visible" | "pending");
        // edited_at 是秒级 DATETIME，乐观锁只靠它比对版本：同一秒内的两次编辑会得到相同的值，旧表单就“骗过”了冲突检测。
        // 所以每次编辑都保证比上一次的 edited_at 至少晚一秒（GREATEST），每个版本的时间戳都严格递增，冲突判定精确。
        // 代价：显示的「编辑于」时间可能比实际保存时刻晚至多一秒。
        await tx
          .update(posts)
          .set({
            bodyMd: body.publicMd,
            hasGate: gateRes.gateCount > 0,
            editedAt: sql`GREATEST(NOW(), COALESCE(${posts.editedAt} + INTERVAL 1 SECOND, NOW()))`,
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
    // 本次保存新建的下载附件：提交之后派发（与其它事件一样，失败只记日志）
    for (const u of uploads) {
      await notify(deps, "attachment.uploaded", { ...u, uploaderId: viewer.userId! });
    }
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
        return { ok: true, postId: hit.postId, threadId: hit.threadId, kind, forumId };
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
