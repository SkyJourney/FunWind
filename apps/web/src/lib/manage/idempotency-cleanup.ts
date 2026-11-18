import "server-only";

import { affectedRowsOf, getWebDb, manageApiIdempotency } from "@funwind/db";
import { lte, sql } from "drizzle-orm";

const BATCH_SIZE = 1000;
const MAX_BATCHES = 60;
const BUDGET_MS = 5000;

type CleanupDependencies = {
  deleteBatch?: (limit: number) => Promise<number>;
  now?: () => number;
};

/** 按到期时间删除单批，不开启跨批事务；NOW() 由连接按北京时间求值。 */
async function deleteExpiredBatch(limit: number): Promise<number> {
  const result = await getWebDb()
    .delete(manageApiIdempotency)
    .where(lte(manageApiIdempotency.expiresAt, sql`NOW()`))
    .orderBy(manageApiIdempotency.expiresAt)
    .limit(limit);
  return affectedRowsOf(result);
}

/** 清扫多批并汇总实际删除数；时间预算只阻止启动新批次，不中断已发出的删除。 */
export async function cleanupExpiredManageApiIdempotency({
  deleteBatch = deleteExpiredBatch,
  now = () => performance.now(),
}: CleanupDependencies = {}): Promise<number> {
  const deadline = now() + BUDGET_MS;
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    if (batch > 0 && now() >= deadline) break;
    const removed = await deleteBatch(BATCH_SIZE);
    total += removed;
    if (removed < BATCH_SIZE) break;
  }
  return total;
}
