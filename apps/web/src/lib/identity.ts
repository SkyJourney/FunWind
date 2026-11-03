import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { accountDeletionRequests, users } from "@funwind/db";
import type { DbTx } from "@/lib/audit";

type LockedUser = Pick<typeof users.$inferSelect, "id" | "state">;

export type ActiveUserLockResult =
  { ok: true; user: LockedUser } | { ok: false; code: "not_found" | "inactive" | "closing" };

/**
 * 在调用方事务中按原序锁定单用户并复核写封存；不创建事务或借用其他连接。
 * 先区分缺失/非 active，再查询 pending/completed，错误展示与前置锁序由调用方保留。
 * 不替代多用户升序锁、仅存在性检查或需要单独锁注销行的路径。
 */
export async function lockActiveUserInTx(tx: DbTx, userId: number): Promise<ActiveUserLockResult> {
  const [user] = await tx
    .select({ id: users.id, state: users.state })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for("update");
  if (!user) return { ok: false, code: "not_found" };
  if (user.state !== "active") return { ok: false, code: "inactive" };

  const [closure] = await tx
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, userId),
        inArray(accountDeletionRequests.status, ["pending", "completed"]),
      ),
    )
    .limit(1);
  if (closure) return { ok: false, code: "closing" };
  return { ok: true, user };
}
