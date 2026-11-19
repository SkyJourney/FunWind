import { eq } from "drizzle-orm";
import { forums, getWebDb, posts, threads, userStats } from "@funwind/db";
import { writeAudit, type ConfigActor, type DbTx } from "@/lib/audit";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { loadFreshAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubject, loadSubjectFrom } from "@/lib/authz/subject";
import type { AuthzSnapshot, Subject } from "@/lib/authz/types";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";
import { forumSelectCols } from "@/lib/forums/select";
import { lockUserStats } from "@/lib/locks";
import { lockForum, lockThread } from "@/lib/posting/locks";
import { executeRestoreInTx } from "@/lib/posting/mutate";

/**
 * 内容管理查询（M9.5 §9.2-A；M19 吸收审核队列）：后台跨主题/回帖的**定位**能力——
 * 标题/正文关键词 + 板块 + 六态筛选 + 分页，服务层按版主作用域过滤（admin.recycle 持全站视角）。
 * 主题与回帖共用一套状态机与操作，行内动作按 kind 分派。
 */

/** 「权限 → 数据范围」映射的唯一实现（M20 分层纪律）：后台页面与 /api/manage/contents 共用 */
export type ContentScope = {
  /** 可达内容管理语义（site.admin / admin.recycle / 版主任一）；false = 不可见 */
  accessible: boolean;
  /** null = 全站视角；数组 = 版主所辖版块；空数组 = 无可见版块 */
  scopeForumIds: number[] | null;
};

export async function resolveContentScope(subject: Subject): Promise<ContentScope> {
  const [isSiteAdmin, hasRecycle, moderated] = await Promise.all([
    checkPermission(subject, "site.admin"),
    checkPermission(subject, "admin.recycle"),
    getModeratedForumIds(subject),
  ]);
  const accessible = isSiteAdmin.allowed || hasRecycle.allowed || moderated.length > 0;
  return {
    accessible,
    scopeForumIds: isSiteAdmin.allowed || hasRecycle.allowed ? null : moderated,
  };
}

/**
 * 主题级设置（锁定 / 置顶 / 精华）——M9.5 §9.2-C 补写入口。
 * 权限：版主可设所辖版块的主题；置顶级别版主最高 1（版块级），site.admin 可设到 3（全站）。
 */
export type ModerationWriteDenial<Code extends string> = {
  ok: false;
  code: Code;
  message?: string;
};
export type ModerationApiTrace = { requestId: string; tokenSuffix: string };
export type PreparedModerationWrite<T, Code extends string> = {
  ok: true;
  lock(tx: DbTx): Promise<
    | {
        ok: true;
        execute(): Promise<
          { ok: true; data: T; afterCommit?: () => Promise<void> } | ModerationWriteDenial<Code>
        >;
      }
    | ModerationWriteDenial<Code>
  >;
};

/** 锁住已确认归属的目标版块，再按同事务的最新主体、实际祖先和读策略复验 API 权限。 */
export async function lockModerationAccess(
  tx: DbTx,
  subject: Subject,
  forumId: number,
  action: "review" | "thread_flags",
): Promise<boolean> {
  if (subject.userId === null) return false;
  // 审核可能改版块计数，维持原排他锁；锁帖只需共享锁稳住版块归属。
  const [lockedForum] = await tx
    .select(forumSelectCols)
    .from(forums)
    .where(eq(forums.id, forumId))
    .for(action === "review" ? "update" : "share");
  if (!lockedForum) return false;
  const current = await loadSubjectFrom(tx, subject.userId, subject.registerMode, true);
  if (current.userId !== subject.userId) return false;
  const snapshot = await loadFreshAuthzSnapshot(tx, {
    lockedForum,
    roleKeys: [...new Set(current.roles.map(({ key }) => key))],
  });
  if (!snapshot.tree.has(forumId)) return false;
  if (action === "thread_flags")
    return (await threadFlagsAccess(current, forumId, snapshot)).allowed;
  return (await checkPermission(current, "forum.moderate", { forumId }, snapshot)).allowed;
}

// ---------- 帖子治理目标（M20：prepareApiReview / prepareApiRestore 共用的探测与锁序） ----------

/** 事务外的帖子定位探测：只读状态、作者、主题与版块，供权限预判与锁序使用 */
export async function loadPostContext(postId: number) {
  const [row] = await getWebDb()
    .select({
      postState: posts.state,
      authorId: posts.authorId,
      threadId: threads.id,
      forumId: threads.forumId,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(eq(posts.id, postId))
    .limit(1);
  return row ?? null;
}

export type PostContext = NonNullable<Awaited<ReturnType<typeof loadPostContext>>>;

/**
 * 按原锁序稳定作者、主题、帖子、版块（user_stats → thread → post → forum）；
 * apiSubject 缺省为后台路径（补统计行、排他锁版块），传入时为 API 路径（不补统计行、
 * 经 lockModerationAccess 复验最新主体权限）。回放可以在此后结束，不判断状态或版本。
 */
export async function lockModerationTarget(
  tx: DbTx,
  postId: number,
  ctx: PostContext,
  apiSubject?: Subject,
) {
  let hasStats = true;
  if (apiSubject) {
    // API 锁阶段不写数据；不能在持主题锁后再尝试补统计行。
    const [stats] = await tx
      .select({ userId: userStats.userId })
      .from(userStats)
      .where(eq(userStats.userId, ctx.authorId))
      .for("update");
    hasStats = !!stats;
  } else {
    await lockUserStats(tx, ctx.authorId);
  }
  const thread = await lockThread(tx, ctx.threadId);
  if (!thread || thread.forumId !== ctx.forumId) return null;
  const [post] = await tx
    .select({
      threadId: posts.threadId,
      authorId: posts.authorId,
      state: posts.state,
      editedAt: posts.editedAt,
      replyToPostId: posts.replyToPostId,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .for("update");
  if (!post || post.threadId !== ctx.threadId || post.authorId !== ctx.authorId) return null;
  if (apiSubject) {
    if (!(await lockModerationAccess(tx, apiSubject, thread.forumId, "review"))) return null;
  } else {
    await lockForum(tx, thread.forumId);
  }
  return { post, hasStats };
}

export type ThreadFlagsResult =
  { ok: true } | { ok: false; code: "not_found" | "forbidden" | "bad_pin"; message: string };

const threadNotFound = { ok: false, code: "not_found", message: "主题不存在" } as const;
type ThreadFlagsPatch = { isLocked?: boolean; isFeatured?: boolean; pinLevel?: number };

/** 在事务外按现有管理员／版主规则授权，并记住本次已授权的版块。 */
async function authorizeThreadFlags(subject: Subject, threadId: number) {
  const [row] = await getWebDb()
    .select({ forumId: threads.forumId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  if (!row) return threadNotFound;
  const { forumId } = row;
  const { allowed, isSiteAdmin } = await threadFlagsAccess(subject, forumId);
  if (!allowed) {
    return { ok: false as const, code: "forbidden" as const, message: "你不是该版块的版主" };
  }
  return { ok: true as const, forumId, isSiteAdmin };
}

/** 锁帖沿用后台权限：站点管理员或目标版块的版主。 */
async function threadFlagsAccess(subject: Subject, forumId: number, snapshot?: AuthzSnapshot) {
  const isSiteAdmin = (await checkPermission(subject, "site.admin", {}, snapshot)).allowed;
  const allowed =
    isSiteAdmin ||
    (await checkPermission(subject, "forum.moderate", { forumId }, snapshot)).allowed;
  return { allowed, isSiteAdmin };
}

/** 持锁后先核对主题归属。 */
async function lockThreadFlagsTarget(tx: DbTx, threadId: number, forumId: number) {
  const thread = await lockThread(tx, threadId);
  return thread?.forumId === forumId ? thread : null;
}

/** 两个入口共用锁内更新；仅 API 同值不写入（覆盖本次请求携带的全部旗标），原后台保留修改与审计语义。 */
async function applyThreadFlags(
  tx: DbTx,
  thread: NonNullable<Awaited<ReturnType<typeof lockThreadFlagsTarget>>>,
  patch: ThreadFlagsPatch,
  actor: ConfigActor,
  trace?: ModerationApiTrace,
): Promise<boolean> {
  // API 幂等口径：请求携带的每一项都与现值相同 → 零写入零审计（后台无 trace，维持原样照写）
  const unchanged =
    (patch.isLocked === undefined || patch.isLocked === thread.isLocked) &&
    (patch.isFeatured === undefined || patch.isFeatured === thread.isFeatured) &&
    (patch.pinLevel === undefined || patch.pinLevel === thread.pinLevel);
  if (trace && unchanged) return false;
  await tx.update(threads).set(patch).where(eq(threads.id, thread.id));
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "admin.thread.flags",
    targetType: "thread",
    targetId: thread.id,
    // before 只记本次请求携带的旗标旧值（与 after 的 patch 键一一对应）
    ...(trace
      ? {
          before: {
            ...(patch.isLocked !== undefined ? { isLocked: thread.isLocked } : {}),
            ...(patch.isFeatured !== undefined ? { isFeatured: thread.isFeatured } : {}),
            ...(patch.pinLevel !== undefined ? { pinLevel: thread.pinLevel } : {}),
          },
        }
      : {}),
    after: trace
      ? { ...patch, via: "api", requestId: trace.requestId, tokenSuffix: trace.tokenSuffix }
      : { ...patch, via: actor.via },
    ip: actor.ip,
  });
  return true;
}

export async function setThreadFlags(
  operator: { userId: number | null },
  threadId: number,
  flags: { locked?: boolean; featured?: boolean; pinLevel?: number },
  actor: { userId: number; via: "admin"; ip: string | null },
): Promise<ThreadFlagsResult> {
  if (operator.userId === null) return { ok: false, code: "forbidden", message: "请先登录" };
  // 评估器需要完整主体；后台入口只有用户 ID。
  const subject = await loadSubject(operator.userId);
  const access = await authorizeThreadFlags(subject, threadId);
  if (!access.ok) return access;
  const maxPin = access.isSiteAdmin ? 3 : 1;
  if (flags.pinLevel !== undefined && flags.pinLevel > maxPin) {
    return { ok: false, code: "bad_pin", message: `置顶级别超出权限（最高 ${maxPin}）` };
  }

  const patch: ThreadFlagsPatch = {};
  if (flags.locked !== undefined) patch.isLocked = flags.locked;
  if (flags.featured !== undefined) patch.isFeatured = flags.featured;
  if (flags.pinLevel !== undefined) patch.pinLevel = flags.pinLevel;
  if (Object.keys(patch).length === 0) return { ok: false, code: "not_found", message: "没有变更" };

  return getWebDb().transaction(async (tx) => {
    const thread = await lockThreadFlagsTarget(tx, threadId, access.forumId);
    if (!thread) return threadNotFound;
    await applyThreadFlags(tx, thread, patch, actor);
    return { ok: true };
  });
}

type ApiThreadLockData = { threadId: number; locked: boolean; changed: boolean };
type PreparedApiThreadLock = PreparedModerationWrite<ApiThreadLockData, "not_found">;

/** 设置明确的目标锁位，不承诺版本；读取旧锁位、更新和变更审计均用调用方事务。 */
export async function prepareApiThreadLock(
  subject: Subject,
  threadId: number,
  locked: boolean,
  actor: ConfigActor,
  trace: ModerationApiTrace,
): Promise<PreparedApiThreadLock | typeof threadNotFound> {
  if (subject.userId === null) return threadNotFound;
  const access = await authorizeThreadFlags(subject, threadId);
  if (!access.ok) return threadNotFound;
  const apiActor = { ...actor, userId: subject.userId };
  return {
    ok: true,
    async lock(tx) {
      const thread = await lockThreadFlagsTarget(tx, threadId, access.forumId);
      if (!thread || !(await lockModerationAccess(tx, subject, thread.forumId, "thread_flags"))) {
        return threadNotFound;
      }
      return {
        ok: true,
        async execute() {
          const changed = await applyThreadFlags(tx, thread, { isLocked: locked }, apiActor, trace);
          return { ok: true, data: { threadId, locked, changed } };
        },
      };
    },
  };
}

type ApiThreadFlagsInput = { featured?: boolean; pinLevel?: number };
/** data 按请求携带的键回显：featured/pinLevel 只有在请求里出现时才出现在响应中 */
type ApiThreadFlagsData =
  | { threadId: number; changed: boolean }
  | { threadId: number; changed: boolean; featured: boolean }
  | { threadId: number; changed: boolean; pinLevel: number }
  | { threadId: number; changed: boolean; featured: boolean; pinLevel: number };
type PreparedApiThreadFlags = PreparedModerationWrite<ApiThreadFlagsData, "not_found">;

/**
 * 主题精华 / 置顶级别（M20：PATCH /api/manage/threads/{id}/flags）。
 * 输入校验在事务外（至少一项 → bad_flags；pinLevel 须整数 1–3 且不超过角色上限：版主 1、
 * site.admin 3 → bad_pin）；锁内 lockThreadFlagsTarget + lockModerationAccess 复验归属与最新权限。
 * 同值请求 changed:false 且不写审计（镜像 applyThreadFlags 的 API 幂等分支）。
 */
export async function prepareApiThreadFlags(
  subject: Subject,
  threadId: number,
  input: ApiThreadFlagsInput,
  actor: ConfigActor,
  trace: ModerationApiTrace,
): Promise<PreparedApiThreadFlags | ModerationWriteDenial<"not_found" | "bad_flags" | "bad_pin">> {
  const { featured, pinLevel } = input;
  if (featured === undefined && pinLevel === undefined) {
    return { ok: false as const, code: "bad_flags" as const, message: "至少提供一项要变更的旗标" };
  }
  if (pinLevel !== undefined && (!Number.isInteger(pinLevel) || pinLevel < 1 || pinLevel > 3)) {
    return { ok: false as const, code: "bad_pin" as const, message: "置顶级别只能是 1–3 的整数" };
  }
  if (subject.userId === null) return threadNotFound;
  // 事务外预授权（拿版块归属与 isSiteAdmin）；越权与不存在同型 not_found，不泄露存在性
  const access = await authorizeThreadFlags(subject, threadId);
  if (!access.ok) return threadNotFound;
  const maxPin = access.isSiteAdmin ? 3 : 1;
  if (pinLevel !== undefined && pinLevel > maxPin) {
    return {
      ok: false as const,
      code: "bad_pin" as const,
      message: `置顶级别超出权限（最高 ${maxPin}）`,
    };
  }
  const apiActor = { ...actor, userId: subject.userId };
  const patch: ThreadFlagsPatch = {};
  if (featured !== undefined) patch.isFeatured = featured;
  if (pinLevel !== undefined) patch.pinLevel = pinLevel;
  return {
    ok: true,
    async lock(tx) {
      const thread = await lockThreadFlagsTarget(tx, threadId, access.forumId);
      if (!thread || !(await lockModerationAccess(tx, subject, thread.forumId, "thread_flags"))) {
        return threadNotFound;
      }
      return {
        ok: true,
        async execute() {
          const changed = await applyThreadFlags(tx, thread, patch, apiActor, trace);
          return {
            ok: true,
            data: {
              threadId,
              changed,
              ...(featured !== undefined ? { featured } : {}),
              ...(pinLevel !== undefined ? { pinLevel } : {}),
            },
          };
        },
      };
    },
  };
}

type ApiRestoreInput = { expectedEditedAt: string | null };
type ApiRestoreData = { postId: number; threadId: number; state: "visible" };
type ApiRestoreCode = "not_found" | "bad_state" | "conflict";
type PreparedApiRestore = PreparedModerationWrite<ApiRestoreData, ApiRestoreCode>;

/**
 * 版主恢复已删内容（M20：POST /api/manage/posts/{id}/restore，deleted → visible）。
 * 与 prepareApiReview 同一探测、锁序与锁内复验；状态机与版本口径在无回放的执行阶段判定：
 * 仅 deleted 可恢复（hidden/disabled/pending → bad_state），expectedEditedAt 与锁内
 * posts.editedAt 比对（null = 免版本），不一致 → conflict。计数与审计经 executeRestoreInTx
 * 与后台 restorePost 完全同源；作者通知复用 content.moderated(restore) 事件，走事务性 outbox。
 */
export async function prepareApiRestore(
  subject: Subject,
  postId: number,
  input: ApiRestoreInput,
  actor: ConfigActor,
  trace: ModerationApiTrace,
): Promise<PreparedApiRestore | ModerationWriteDenial<"not_found">> {
  const notFound = { ok: false as const, code: "not_found" as const, message: "帖子不存在" };
  if (subject.userId === null) return notFound;
  const operatorId = subject.userId;
  const ctx = await loadPostContext(postId);
  if (
    !ctx ||
    !(await checkPermission(subject, "forum.moderate", { forumId: ctx.forumId })).allowed
  ) {
    return notFound;
  }
  return {
    ok: true,
    async lock(tx) {
      const target = await lockModerationTarget(tx, postId, ctx, subject);
      if (!target) return notFound;
      return {
        ok: true,
        async execute() {
          const { post } = target;
          // API 恢复比后台更严：只接受 deleted（hidden 的可见化是版主审核动作，不经此端点）
          if (post.state !== "deleted") {
            return {
              ok: false as const,
              code: "bad_state" as const,
              message: `当前状态是 ${post.state}，只能恢复已删除的内容`,
            };
          }
          if (post.editedAt !== input.expectedEditedAt) {
            return {
              ok: false as const,
              code: "conflict" as const,
              message: "内容已编辑，请刷新后再恢复",
            };
          }
          if (!target.hasStats) {
            throw new Error(`用户 ${post.authorId} 缺少统计行，拒绝迁移；请先 db:recount`);
          }
          const transition = await executeRestoreInTx(tx, postId, {
            actorId: operatorId,
            ip: actor.ip,
            apiTrace: trace,
          });
          if (!transition.ok) {
            return {
              ok: false as const,
              code:
                transition.code === "not_found" ? ("not_found" as const) : ("bad_state" as const),
              message: "状态迁移失败",
            };
          }
          // 与后台恢复同一事件（消费者据此通知作者 content.restored）；API 走事务性 outbox，提交后快派
          const enqueued: EnqueuedEvent[] = [
            await enqueueEventInTx(
              tx,
              "content.moderated",
              { postId, operatorId, action: "restore" },
              { actorId: operatorId, source: "moderation" },
            ),
          ];
          return {
            ok: true as const,
            data: { postId, threadId: transition.threadId, state: "visible" },
            async afterCommit() {
              await dispatchOutboxRows(enqueued);
              await sweepPending();
            },
          };
        },
      };
    },
  };
}

// 只读查询已拆至 content-queries.ts（M20.3 棘轮拆分）；此处 re-export 维持既有 import 路径稳定。
export {
  type ContentKind,
  type ContentStateFilter,
  type ContentListFilters,
  type ContentListItem,
  listContentsPage,
  type ThreadDetail,
  type ReplyDetail,
  type ContentDetail,
  type ContentDetailResult,
  loadContentDetail,
} from "./content-queries";
