/** MySQL 死锁（ER_LOCK_DEADLOCK / errno 1213）；drizzle 会把 mysql2 错误包在 cause 里 */
export function isDeadlock(e: unknown): boolean {
  const err = e as { code?: string; errno?: number; cause?: { code?: string; errno?: number } };
  return [err, err?.cause].some((x) => x?.code === "ER_LOCK_DEADLOCK" || x?.errno === 1213);
}

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
