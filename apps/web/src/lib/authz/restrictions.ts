import { and, eq, sql } from "drizzle-orm";
import { getWebDb, userRestrictions } from "@funwind/db";

/**
 * 用户限制的“当前生效”判定（库内 DATETIME 为北京墙面时间，连接层 +08:00，NOW() 与之同口径）。
 * 抽成独立叶子模块：session（会话有效性）与 subject（权限主体）都要用，避免循环依赖。
 */
export const restrictionActive = sql`${userRestrictions.startsAt} <= NOW()
  AND (${userRestrictions.endsAt} IS NULL OR ${userRestrictions.endsAt} > NOW())`;

/** 用户当前生效的全站封禁（kind=ban, scope=0）；没有则 null。用于登录拦截与会话失效 */
export async function findActiveGlobalBan(
  userId: number,
): Promise<{ reason: string; endsAt: string | null } | null> {
  const rows = await getWebDb()
    .select({ reason: userRestrictions.reason, endsAt: userRestrictions.endsAt })
    .from(userRestrictions)
    .where(
      and(
        eq(userRestrictions.userId, userId),
        eq(userRestrictions.kind, "ban"),
        eq(userRestrictions.scopeId, 0),
        restrictionActive,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
