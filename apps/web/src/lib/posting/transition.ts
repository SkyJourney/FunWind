import { and, desc, eq, ne, sql } from "drizzle-orm";
import { forums, posts, threads, userStats } from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import type { ContentState } from "@/lib/authz/evaluator";
import { counterDelta, isVisible, type CounterDelta, type TransitionFacts } from "./counters";
import { lockForum, lockThread, lockUserStats } from "./locks";

/**
 * 内容状态迁移的唯一入口（M6.1，设计稿 §3.2）。发布、审核通过、驳回、隐藏、软删、恢复全部走这里，
 * 在**同一个事务**内完成：改状态 → 按 counterDelta 更新各缓存计数 → 回查"最后一帖"类指针 → 写审计。
 * 创建新帖不走 transitionContent（帖子还不存在），但与它共用 applyCounterDelta，口径只有一份。
 *
 * 调用方在事务外已完成权限判断（rules.ts）；这里在持锁后重读事实（状态可能已被并发操作改变），以库里的为准。
 * 加锁顺序：作者 user_stats → 主题行 → 帖子行 → 版块行（见 locks.ts）。
 */

export interface TransitionOptions {
  actorId: number | null;
  ip?: string | null;
  /** 版主理由，写进审计；作者自己的动作可省略 */
  reason?: string;
  /** 是否写审计（作者删自己的帖子默认不写，版主动作必须写） */
  audit?: boolean;
}

export type TransitionResult =
  | { ok: false; code: "not_found" }
  | {
      ok: true;
      /** false = 状态本来就是目标状态，什么都没做 */
      changed: boolean;
      kind: "thread" | "reply";
      from: ContentState;
      to: ContentState;
      postId: number;
      floor: number;
      threadId: number;
      forumId: number;
      authorId: number;
      threadAuthorId: number;
    };

/** 计数应用所需的上下文（transitionContent 与创建路径共用） */
export interface CounterContext {
  threadId: number;
  forumId: number;
  threadCreatedAt: string;
  postId: number;
  authorId: number;
  postCreatedAt: string;
}

/** 无符号计数列加减：下溢夹在 0（计数漂移由 db:recount 修复，不能因此让用户的操作 500） */
const bump = (col: Parameters<typeof sql>[1], n: number) =>
  sql`GREATEST(CAST(${col} AS SIGNED) + ${n}, 0)`;

/** 把增量落到 threads / forums / user_stats，并按指针策略前移或回查。调用方须已按顺序持有相关行锁 */
export async function applyCounterDelta(
  tx: DbTx,
  ctx: CounterContext,
  delta: CounterDelta,
): Promise<void> {
  if (delta.thread.replyCount !== 0) {
    await tx
      .update(threads)
      .set({ replyCount: bump(threads.replyCount, delta.thread.replyCount) })
      .where(eq(threads.id, ctx.threadId));
  }
  if (delta.forum.threadCount !== 0 || delta.forum.postCount !== 0) {
    await tx
      .update(forums)
      .set({
        threadCount: bump(forums.threadCount, delta.forum.threadCount),
        postCount: bump(forums.postCount, delta.forum.postCount),
      })
      .where(eq(forums.id, ctx.forumId));
  }
  if (
    delta.author.threadCount !== 0 ||
    delta.author.postCount !== 0 ||
    delta.author.featuredCount !== 0
  ) {
    await tx
      .update(userStats)
      .set({
        threadCount: bump(userStats.threadCount, delta.author.threadCount),
        postCount: bump(userStats.postCount, delta.author.postCount),
        featuredCount: bump(userStats.featuredCount, delta.author.featuredCount),
      })
      .where(eq(userStats.userId, ctx.authorId));
  }

  // 指针：先主题、后版块（版块的"最后活跃主题"依赖主题的 last_posted_at）、再作者
  if (delta.pointers.thread === "advance") {
    await tx
      .update(threads)
      .set({
        lastPostId: ctx.postId,
        lastPosterId: ctx.authorId,
        lastPostedAt: ctx.postCreatedAt,
      })
      .where(eq(threads.id, ctx.threadId));
  } else if (delta.pointers.thread === "recompute") {
    await recomputeThreadPointer(tx, ctx.threadId, ctx.threadCreatedAt);
  }

  if (delta.pointers.forum === "advance") {
    await tx
      .update(forums)
      .set({ lastPostId: ctx.postId, lastPostedAt: ctx.postCreatedAt })
      .where(eq(forums.id, ctx.forumId));
  } else if (delta.pointers.forum === "recompute") {
    await recomputeForumPointer(tx, ctx.forumId);
  }

  if (delta.pointers.author === "advance") {
    await tx
      .update(userStats)
      .set({ lastPostAt: ctx.postCreatedAt })
      .where(eq(userStats.userId, ctx.authorId));
  } else if (delta.pointers.author === "recompute") {
    const [row] = await tx
      .select({ at: sql<string | null>`MAX(${posts.createdAt})` })
      .from(posts)
      .where(and(eq(posts.authorId, ctx.authorId), eq(posts.state, "visible")));
    await tx
      .update(userStats)
      .set({ lastPostAt: row?.at ?? null })
      .where(eq(userStats.userId, ctx.authorId));
  }
}

/** 主题的最后一帖 = 可见帖里楼层最大者；没有可见帖则清空指针、时间回落到主题创建时间 */
async function recomputeThreadPointer(tx: DbTx, threadId: number, threadCreatedAt: string) {
  const [last] = await tx
    .select({ id: posts.id, authorId: posts.authorId, createdAt: posts.createdAt })
    .from(posts)
    .where(and(eq(posts.threadId, threadId), eq(posts.state, "visible")))
    .orderBy(desc(posts.floor))
    .limit(1);
  await tx
    .update(threads)
    .set({
      lastPostId: last?.id ?? null,
      lastPosterId: last?.authorId ?? null,
      lastPostedAt: last?.createdAt ?? threadCreatedAt,
    })
    .where(eq(threads.id, threadId));
}

/** 版块的最后一帖 = 可见主题里 last_posted_at 最大者（并列取 id 大者）的最后一帖 */
async function recomputeForumPointer(tx: DbTx, forumId: number) {
  const [top] = await tx
    .select({ lastPostId: threads.lastPostId, lastPostedAt: threads.lastPostedAt })
    .from(threads)
    .where(and(eq(threads.forumId, forumId), eq(threads.state, "visible")))
    .orderBy(desc(threads.lastPostedAt), desc(threads.id))
    .limit(1);
  await tx
    .update(forums)
    .set({ lastPostId: top?.lastPostId ?? null, lastPostedAt: top?.lastPostedAt ?? null })
    .where(eq(forums.id, forumId));
}

/** 审计动作名：post.state.<目标状态> */
const auditAction = (to: ContentState) => `post.state.${to}`;

export async function transitionContent(
  tx: DbTx,
  postId: number,
  to: ContentState,
  opts: TransitionOptions,
): Promise<TransitionResult> {
  // 1. 先无锁读一次，只为知道要锁谁（作者、主题）。真正的事实在持锁后重读
  const [probe] = await tx
    .select({ threadId: posts.threadId, authorId: posts.authorId })
    .from(posts)
    .where(eq(posts.id, postId));
  if (!probe) return { ok: false, code: "not_found" };

  // 2. 按全局顺序加锁：作者统计行 → 主题行 → 帖子行 → 版块行
  await lockUserStats(tx, probe.authorId);
  const thread = await lockThread(tx, probe.threadId);
  if (!thread) return { ok: false, code: "not_found" };
  const [post] = await tx
    .select({
      id: posts.id,
      floor: posts.floor,
      authorId: posts.authorId,
      state: posts.state,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .for("update");
  if (!post) return { ok: false, code: "not_found" };
  await lockForum(tx, thread.forumId);

  const kind: "thread" | "reply" = thread.firstPostId === post.id ? "thread" : "reply";
  const from = post.state;
  const base = {
    ok: true as const,
    kind,
    from,
    to,
    postId: post.id,
    floor: post.floor,
    threadId: thread.id,
    forumId: thread.forumId,
    authorId: post.authorId,
    threadAuthorId: thread.authorId,
  };
  if (from === to) return { ...base, changed: false };

  // 主题与首帖状态同事务同步：对主题的迁移要求两者此刻一致，否则说明数据已分叉，宁可报错也不在分叉数据上算计数
  if (kind === "thread" && thread.state !== from) {
    throw new Error(
      `主题 ${thread.id} 与首帖 ${post.id} 状态分叉（${thread.state} / ${from}），拒绝迁移；请先 db:verify / db:recount 排查`,
    );
  }

  // 3. 事实：迁移前读（可见回帖数、是否最新楼层都取"迁移前、排除本帖"的口径）
  const [others] = await tx
    .select({
      visibleReplies: sql<number>`COUNT(*)`,
      maxFloor: sql<number | null>`MAX(${posts.floor})`,
    })
    .from(posts)
    .where(and(eq(posts.threadId, thread.id), eq(posts.state, "visible"), ne(posts.id, post.id)));
  const visibleOthers = Number(others?.visibleReplies ?? 0);
  const maxOtherFloor = others?.maxFloor === null ? 0 : Number(others?.maxFloor ?? 0);
  const facts: TransitionFacts = {
    kind,
    before: from,
    after: to,
    threadVisible: isVisible(thread.state),
    // 主题迁移：除首帖外的可见回帖数（首帖就是被迁移的这条，已被 ne 排除）
    visibleReplies: kind === "thread" ? visibleOthers : 0,
    isFeatured: thread.isFeatured,
    isLatest: post.floor > maxOtherFloor,
  };
  const delta = counterDelta(facts);

  // 4. 改状态（主题迁移同步改首帖与主题），再应用计数与指针
  await tx.update(posts).set({ state: to }).where(eq(posts.id, post.id));
  if (kind === "thread") {
    await tx.update(threads).set({ state: to }).where(eq(threads.id, thread.id));
  }
  await applyCounterDelta(
    tx,
    {
      threadId: thread.id,
      forumId: thread.forumId,
      threadCreatedAt: thread.createdAt,
      postId: post.id,
      authorId: post.authorId,
      postCreatedAt: post.createdAt,
    },
    delta,
  );

  // 5. 审计（理由只放版主写的那句话；绝不放正文）
  if (opts.audit) {
    await writeAudit(tx, {
      actorId: opts.actorId,
      action: auditAction(to),
      targetType: "post",
      targetId: post.id,
      before: { state: from },
      after: { state: to, kind, threadId: thread.id, reason: opts.reason ?? null },
      ip: opts.ip ?? null,
    });
  }
  return { ...base, changed: true };
}
