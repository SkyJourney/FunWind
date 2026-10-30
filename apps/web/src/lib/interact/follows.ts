import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { accountDeletionRequests, follows, getWebDb, forums, userStats, users } from "@funwind/db";
import { nowBeijingWallTime } from "@/lib/datetime";
import type { DbTx } from "@/lib/audit";
import { enqueueEventInTx, sweepPending } from "@/lib/events/outbox";
import { isDuplicateKey } from "@/lib/auth/register";
import { checkPermission } from "@/lib/authz/service";
import { loadSubject } from "@/lib/authz/subject";

/**
 * 关注（M8）：用户与版块同一张表（target_type 区分），主键天然防重；toggle 在事务内
 * 完成「明细 insert/delete + user_stats.follower_count 同步」（口径与 recount.ts:52-65 一致，
 * 只数 target_type='user'；版块无粉丝计数列——版块「加入人数」实时 COUNT）。
 * `user.followed`（仅关注方向）在事务内经 outbox 登记。
 */

export type FollowTargetType = "user" | "forum";

export type ToggleFollowResult =
  { ok: true; following: boolean } | { ok: false; code: "not_found" };

/** 事务内：目标必须存在（用户须 active；版块须存在） */
async function targetExists(tx: DbTx, type: FollowTargetType, id: number): Promise<boolean> {
  if (type === "user") {
    const [u] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, id),
          eq(users.state, "active"),
          notExists(
            tx
              .select({ id: accountDeletionRequests.id })
              .from(accountDeletionRequests)
              .where(
                and(
                  eq(accountDeletionRequests.userId, users.id),
                  eq(accountDeletionRequests.status, "completed"),
                ),
              ),
          ),
        ),
      )
      .limit(1);
    return u !== undefined;
  }
  const [f] = await tx.select({ id: forums.id }).from(forums).where(eq(forums.id, id)).limit(1);
  return f !== undefined;
}

/** 关注/取关（toggle）。自关注由调用方（页面不渲染按钮）与主键共同兜底——service 层显式拒绝 */
export async function toggleFollow(
  userId: number,
  targetType: FollowTargetType,
  targetId: number,
): Promise<ToggleFollowResult> {
  if (targetType === "user" && userId === targetId) {
    return { ok: false, code: "not_found" };
  }
  const viewer = await loadSubject(userId);
  if (viewer.userId === null || !(await checkPermission(viewer, "site.visit")).allowed) {
    return { ok: false, code: "not_found" };
  }
  if (
    targetType === "forum" &&
    !(await checkPermission(viewer, "forum.read", { forumId: targetId })).allowed
  ) {
    return { ok: false, code: "not_found" };
  }
  const db = getWebDb();

  const race = await db.transaction(async (tx): Promise<{ race: boolean } | null> => {
    if (!(await targetExists(tx, targetType, targetId))) return null;

    const [existing] = await tx
      .select({ userId: follows.userId })
      .from(follows)
      .where(
        and(
          eq(follows.userId, userId),
          eq(follows.targetType, targetType),
          eq(follows.targetId, targetId),
        ),
      )
      .limit(1);

    if (existing) {
      await tx
        .delete(follows)
        .where(
          and(
            eq(follows.userId, userId),
            eq(follows.targetType, targetType),
            eq(follows.targetId, targetId),
          ),
        );
      if (targetType === "user") {
        await tx
          .update(userStats)
          .set({ followerCount: sql`GREATEST(${userStats.followerCount} - 1, 0)` })
          .where(eq(userStats.userId, targetId));
      }
      return { race: false };
    }

    try {
      await tx
        .insert(follows)
        .values({ userId, targetType, targetId, createdAt: nowBeijingWallTime() });
    } catch (e) {
      if (isDuplicateKey(e)) return { race: true };
      throw e;
    }
    if (targetType === "user") {
      await tx
        .update(userStats)
        .set({ followerCount: sql`${userStats.followerCount} + 1` })
        .where(eq(userStats.userId, targetId));
    }
    await enqueueEventInTx(
      tx,
      "user.followed",
      { userId, targetType, targetId },
      { actorId: userId, source: "interact" },
    );
    return { race: false };
  });

  if (race === null) return { ok: false, code: "not_found" };
  if (!race.race) await sweepPending();
  return { ok: true, following: await isFollowing(userId, targetType, targetId) };
}

export async function isFollowing(
  userId: number,
  targetType: FollowTargetType,
  targetId: number,
): Promise<boolean> {
  const [row] = await getWebDb()
    .select({ userId: follows.userId })
    .from(follows)
    .where(
      and(
        eq(follows.userId, userId),
        eq(follows.targetType, targetType),
        eq(follows.targetId, targetId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** 一批目标的关注状态（用户或版块，按类型） */
export async function followedTargetIds(
  userId: number,
  targetType: FollowTargetType,
  targetIds: readonly number[],
): Promise<Set<number>> {
  if (targetIds.length === 0) return new Set();
  const rows = await getWebDb()
    .select({ targetId: follows.targetId })
    .from(follows)
    .where(
      and(
        eq(follows.userId, userId),
        eq(follows.targetType, targetType),
        inArray(follows.targetId, [...targetIds]),
      ),
    );
  return new Set(rows.map((r) => r.targetId));
}
