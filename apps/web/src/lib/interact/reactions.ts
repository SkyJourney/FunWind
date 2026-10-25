import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getWebDb, posts, reactions, threads, users } from "@funwind/db";
import type { DbTx } from "@/lib/audit";
import { enqueueEventInTx, sweepPending } from "@/lib/events/outbox";
import { nowBeijingWallTime } from "@/lib/datetime";
import { isDuplicateKey } from "@/lib/auth/register";

/**
 * 点赞（M8）：reactions 主键 (user_id, post_id, kind) 天然防重；toggle 在一个事务内完成
 * 「明细 insert/delete + posts.like_count 同步」（口径与 recount.ts:82-89 的明细 COUNT 一致）。
 * `reaction.added`（仅点赞方向）在事务内经 outbox 登记——崩溃不丢单。
 * 只能点赞 visible 帖子（含所属主题 visible）；取消点赞随时允许。
 */

export type ToggleLikeResult =
  { ok: true; liked: boolean; likeCount: number } | { ok: false; code: "not_found" };

/** 事务内：帖子与主题必须双双 visible（点赞是对可见内容的互动） */
async function visiblePostOrNull(tx: DbTx, postId: number) {
  const [row] = await tx
    .select({ threadId: posts.threadId, state: posts.state })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  if (!row || row.state !== "visible") return null;
  const [t] = await tx
    .select({ state: threads.state })
    .from(threads)
    .where(eq(threads.id, row.threadId))
    .limit(1);
  if (!t || t.state !== "visible") return null;
  return row;
}

async function likeCountOf(postId: number): Promise<number> {
  const [row] = await getWebDb()
    .select({ likeCount: posts.likeCount })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return row?.likeCount ?? 0;
}

/** 点赞/取消（toggle）。成功返回最新计数；帖子不存在或不可见返回 not_found */
export async function toggleLike(userId: number, postId: number): Promise<ToggleLikeResult> {
  const db = getWebDb();

  const race = await db.transaction(async (tx): Promise<{ race: boolean } | null> => {
    const target = await visiblePostOrNull(tx, postId);
    if (!target) return null;

    const [existing] = await tx
      .select({ userId: reactions.userId })
      .from(reactions)
      .where(
        and(eq(reactions.userId, userId), eq(reactions.postId, postId), eq(reactions.kind, "like")),
      )
      .limit(1);

    if (existing) {
      await tx
        .delete(reactions)
        .where(
          and(
            eq(reactions.userId, userId),
            eq(reactions.postId, postId),
            eq(reactions.kind, "like"),
          ),
        );
      // 计数与明细同事务（±1，口径与 recount 的明细 COUNT 一致）
      await tx
        .update(posts)
        .set({ likeCount: sql`GREATEST(${posts.likeCount} - 1, 0)` })
        .where(eq(posts.id, postId));
      return { race: false };
    }

    try {
      await tx
        .insert(reactions)
        .values({ userId, postId, kind: "like", createdAt: nowBeijingWallTime() });
    } catch (e) {
      // 并发双击：PK 撞键 = 已存在 → 本次按「已赞」处理（不重复计数、不发事件）
      if (isDuplicateKey(e)) return { race: true };
      throw e;
    }
    await tx
      .update(posts)
      .set({ likeCount: sql`${posts.likeCount} + 1` })
      .where(eq(posts.id, postId));
    await enqueueEventInTx(
      tx,
      "reaction.added",
      { userId, postId, kind: "like" },
      { actorId: userId, source: "interact" },
    );
    return { race: false };
  });

  if (race === null) return { ok: false, code: "not_found" };
  if (race.race) {
    // 并发撞键：状态与计数以库内明细/缓存为准
    return { ok: true, liked: true, likeCount: await likeCountOf(postId) };
  }
  await sweepPending();
  return { ok: true, liked: await isLikedBy(userId, postId), likeCount: await likeCountOf(postId) };
}

export async function isLikedBy(userId: number, postId: number): Promise<boolean> {
  const [row] = await getWebDb()
    .select({ userId: reactions.userId })
    .from(reactions)
    .where(
      and(eq(reactions.userId, userId), eq(reactions.postId, postId), eq(reactions.kind, "like")),
    )
    .limit(1);
  return row !== undefined;
}

/** 当前用户对一批帖子的点赞状态（帖子页一次查询） */
export async function likedPostIds(
  userId: number,
  postIds: readonly number[],
): Promise<Set<number>> {
  if (postIds.length === 0) return new Set();
  const rows = await getWebDb()
    .select({ postId: reactions.postId })
    .from(reactions)
    .where(
      and(
        eq(reactions.userId, userId),
        eq(reactions.kind, "like"),
        inArray(reactions.postId, [...postIds]),
      ),
    );
  return new Set(rows.map((r) => r.postId));
}

export interface ReactorView {
  userId: number;
  username: string | null;
  deleted: boolean;
}

/** 某帖的点赞者（弹层用；最多 20 个，按时间倒序） */
export async function reactorsOf(postId: number, limit = 20): Promise<ReactorView[]> {
  return getWebDb()
    .select({
      userId: reactions.userId,
      username: users.username,
      deleted: sql<boolean>`${users.state} = 'deleted'`,
    })
    .from(reactions)
    .leftJoin(users, eq(users.id, reactions.userId))
    .where(and(eq(reactions.postId, postId), eq(reactions.kind, "like")))
    .orderBy(desc(reactions.createdAt))
    .limit(limit);
}
