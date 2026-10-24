import { eq, sql } from "drizzle-orm";
import { pointAccounts } from "@funwind/db";
import type { DbTx } from "@/lib/audit";

/**
 * 锁定积分账户行并返回当前余额；账户不存在则先建立（余额 0）。必须在事务内调用。
 *
 * 为什么不用 INSERT … ON DUPLICATE KEY UPDATE 当“确保存在 + 加锁”：对已存在的行，它先拿共享锁做重复键检查、
 * 再升级为排他锁——两个事务同时升级就互相死锁（热门作者的账户行上必现）。
 * 正确顺序：先 SELECT … FOR UPDATE（已存在则直接拿排他锁，无升级）；不存在才 INSERT IGNORE，再重新加锁。
 */
export async function lockAccount(tx: DbTx, userId: number): Promise<number> {
  const lock = () =>
    tx
      .select({ balance: pointAccounts.balance })
      .from(pointAccounts)
      .where(eq(pointAccounts.userId, userId))
      .for("update");
  const [existing] = await lock();
  if (existing) return existing.balance;
  await tx
    .insert(pointAccounts)
    .ignore()
    .values({ userId, balance: 0, lifetimeEarned: 0, lifetimeSpent: 0, updatedAt: sql`NOW()` });
  const [created] = await lock();
  return created?.balance ?? 0;
}

/** 按 user_id 升序对多个账户加锁（固定顺序是避免两笔交叉操作互相死锁的约定）；返回各账户余额 */
export async function lockAccounts(
  tx: DbTx,
  userIds: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const id of [...new Set(userIds)].sort((a, b) => a - b))
    out.set(id, await lockAccount(tx, id));
  return out;
}
