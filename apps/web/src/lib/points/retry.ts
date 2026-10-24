/** MySQL 死锁（ER_LOCK_DEADLOCK / errno 1213）；drizzle 会把 mysql2 错误包在 cause 里 */
export function isDeadlock(e: unknown): boolean {
  const err = e as { code?: string; errno?: number; cause?: { code?: string; errno?: number } };
  return [err, err?.cause].some((x) => x?.code === "ER_LOCK_DEADLOCK" || x?.errno === 1213);
}

/**
 * 积分与解锁事务统一使用 READ COMMITTED（审查 P2-16，复查 A6 实测）。
 *
 * 默认的 REPEATABLE READ 下，`SELECT … FOR UPDATE` 命中**不存在**的键会加间隙锁。两个事务各为不同的新用户
 * 首次建账户时，都在同一个间隙里持有间隙锁（间隙锁之间互不冲突），随后各自 INSERT 又互相等对方的间隙锁
 * → 死锁。实测 640 次并发首次入账，1044 次死锁，3 次重试耗尽后 139 次（21.7%）失败成 500。
 * READ COMMITTED 不加间隙锁，已存在行上的排他锁行为不变，加锁顺序约定照旧。
 * 所有包含 `lockAccount` / `applyPointsInTx` 的事务都必须用这个配置开启。
 */
export const POINTS_TX_OPTIONS = { isolationLevel: "read committed" } as const;

/**
 * 事务遇到死锁时整体重试（InnoDB 已回滚了被选中的事务，重放是安全的）。
 * 加锁顺序固定（按 user_id 升序）后死锁已很罕见，这里是最后一道兜底。
 */
export async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isDeadlock(e) || i >= attempts) throw e;
    }
  }
}
