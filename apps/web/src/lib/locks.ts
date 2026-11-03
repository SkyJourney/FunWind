import { eq } from "drizzle-orm";
import { userStats } from "@funwind/db";
import type { DbTx } from "@/lib/audit";

/**
 * 锁住用户的统计行；不存在就补一行再锁（迁移用户已有行，新注册用户在注册事务里建；这里兜底更早注册却没有行的用户）。
 * 先 SELECT … FOR UPDATE，缺失才 INSERT IGNORE——不要用 INSERT … ON DUPLICATE KEY UPDATE 当加锁手段（共享锁升级死锁）。
 * 调用方必须使用 READ COMMITTED，且保持 user_stats → threads → forums → 积分账户的既有锁序。
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
