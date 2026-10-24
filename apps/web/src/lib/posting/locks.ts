import { eq } from "drizzle-orm";
import { forums, threads, userStats } from "@funwind/db";
import type { DbTx } from "@/lib/audit";

/**
 * 写路径的行锁（M6.1，设计稿 §4）。全局加锁顺序固定为：
 *   user_stats → threads → forums（按 id 升序）→ 积分账户
 * 所有写路径事务都按这个顺序取锁，才不会互相死锁。本文件只提供单行加锁原语，顺序由调用方（service / transition）保证。
 * 事务隔离级别必须是 READ COMMITTED（POINTS_TX_OPTIONS）：默认的 REPEATABLE READ 下对"不存在的行"加锁会产生间隙锁，
 * 不同用户首次建统计行时互相死锁（M5.6 前实测过）。
 */

/**
 * 锁住用户的统计行；不存在就补一行再锁（迁移用户已有行，新注册用户在注册事务里建；这里兜底更早注册却没有行的用户）。
 * 先 SELECT … FOR UPDATE，缺失才 INSERT IGNORE——不要用 INSERT … ON DUPLICATE KEY UPDATE 当加锁手段（共享锁升级死锁）。
 */
export async function lockUserStats(tx: DbTx, userId: number): Promise<void> {
  const lock = () =>
    tx
      .select({ userId: userStats.userId })
      .from(userStats)
      .where(eq(userStats.userId, userId))
      .for("update");
  if ((await lock()).length > 0) return;
  await tx.insert(userStats).ignore().values({ userId });
  await lock();
}

/** 锁住主题行并返回加锁后的最新状态；不存在返回 null */
export async function lockThread(tx: DbTx, threadId: number) {
  const [row] = await tx
    .select({
      id: threads.id,
      forumId: threads.forumId,
      authorId: threads.authorId,
      state: threads.state,
      isFeatured: threads.isFeatured,
      isLocked: threads.isLocked,
      firstPostId: threads.firstPostId,
      createdAt: threads.createdAt,
    })
    .from(threads)
    .where(eq(threads.id, threadId))
    .for("update");
  return row ?? null;
}

/** 锁住版块行（计数与最后一帖指针都在这一行上） */
export async function lockForum(tx: DbTx, forumId: number): Promise<void> {
  await tx.select({ id: forums.id }).from(forums).where(eq(forums.id, forumId)).for("update");
}
