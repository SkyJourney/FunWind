import "server-only";

import { and, eq, not } from "drizzle-orm";
import { follows, getWebDb, userProfiles, users } from "@funwind/db";
import { findActiveGlobalBan } from "@/lib/authz/restrictions";
import { publicUserDeleted } from "@/lib/identity-expr";
import type { PmPolicy } from "./policy";

export interface PmTargetSummary {
  id: number;
  state: (typeof users.$inferSelect)["state"];
  pmPolicy: PmPolicy | null;
}

export interface PmTargetReachability {
  target: PmTargetSummary | undefined;
  targetUnavailable: boolean;
  targetPolicyUnavailable: boolean;
}

/**
 * 私信列表页的发起预判：返回目标摘要及账号、策略两种独立的不可用标志。
 * 仅等价承接页面提示：不检查已有会话，pending 注销申请仍按公开身份可见；发送事务继续负责权威复核。
 */
export async function messageTargetReachability(
  userId: number,
  to: number | null,
): Promise<PmTargetReachability> {
  const [target] =
    to !== null && to !== userId
      ? await getWebDb()
          .select({ id: users.id, state: users.state, pmPolicy: userProfiles.pmPolicy })
          .from(users)
          .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
          .where(and(eq(users.id, to), not(publicUserDeleted(users.id, users.state))))
          .limit(1)
      : [];
  const targetBanned =
    target?.state === "active" && (await findActiveGlobalBan(target.id)) !== null;
  const targetUnavailable =
    to !== null && to !== userId && (!target || target.state !== "active" || targetBanned);
  const targetCanMessageByPolicy =
    target?.pmPolicy !== "off" &&
    (target?.pmPolicy !== "following" ||
      (
        await getWebDb()
          .select({ userId: follows.userId })
          .from(follows)
          .where(
            and(
              eq(follows.userId, target.id),
              eq(follows.targetType, "user"),
              eq(follows.targetId, userId),
            ),
          )
          .limit(1)
      ).length > 0);
  const targetPolicyUnavailable =
    to !== null && to !== userId && target !== undefined && !targetCanMessageByPolicy;

  return { target, targetUnavailable, targetPolicyUnavailable };
}
