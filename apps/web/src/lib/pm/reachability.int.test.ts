// @vitest-environment node
import { sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  conversationMembers,
  conversations,
  DEMO,
  follows,
  getWebDb,
  userProfiles,
  userRestrictions,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import type { PmPolicy } from "./policy";
import { messageTargetReachability } from "./reachability";

type UserState = (typeof users.$inferSelect)["state"];
type DeletionStatus = (typeof accountDeletionRequests.$inferSelect)["status"];
interface ReachabilityCase {
  label: string;
  state?: UserState;
  policy?: PmPolicy;
  closure?: DeletionStatus;
  follow?: "target_to_sender" | "sender_to_target" | "forum";
  restriction?: "ban" | "expired_ban" | "future_ban" | "scoped_ban" | "mute";
  existingConversation?: boolean;
  to?: "self" | "missing" | "none";
  hasTarget: boolean;
  unavailable: boolean;
  policyUnavailable: boolean;
}

const cases: ReachabilityCase[] = [
  {
    label: "active + all",
    policy: "all",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: false,
  },
  {
    label: "缺少 profile：nullable 策略照旧放行",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: false,
  },
  {
    label: "state=deleted，即使 off 也不返回摘要",
    state: "deleted",
    policy: "off",
    hasTarget: false,
    unavailable: true,
    policyUnavailable: false,
  },
  {
    label: "pending 注销申请仍按页面公开口径放行",
    closure: "pending",
    policy: "all",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: false,
  },
  {
    label: "pending + off：仅策略不可用",
    closure: "pending",
    policy: "off",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: true,
  },
  {
    label: "已取消注销不改变公开可达性",
    closure: "cancelled",
    policy: "all",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: false,
  },
  {
    label: "active 但 completed tombstone：目标不可用",
    closure: "completed",
    policy: "all",
    hasTarget: false,
    unavailable: true,
    policyUnavailable: false,
  },
  {
    label: "completed + off：不泄露策略提示",
    closure: "completed",
    policy: "off",
    hasTarget: false,
    unavailable: true,
    policyUnavailable: false,
  },
  {
    label: "生效全站 ban",
    restriction: "ban",
    policy: "all",
    hasTarget: true,
    unavailable: true,
    policyUnavailable: false,
  },
  {
    label: "ban + off：两个不可用标志独立保留",
    restriction: "ban",
    policy: "off",
    hasTarget: true,
    unavailable: true,
    policyUnavailable: true,
  },
  {
    label: "已过期 ban 不影响发起预判",
    restriction: "expired_ban",
    policy: "all",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: false,
  },
  {
    label: "未来 ban 尚未生效",
    restriction: "future_ban",
    policy: "all",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: false,
  },
  {
    label: "非全站作用域 ban 不影响私信",
    restriction: "scoped_ban",
    policy: "all",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: false,
  },
  {
    label: "全站 mute 不作为 ban",
    restriction: "mute",
    policy: "all",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: false,
  },
  {
    label: "off 拒绝页面发起预判",
    policy: "off",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: true,
  },
  {
    label: "已有会话 + off：页面仍提示策略不可用，不与发送服务对齐",
    policy: "off",
    existingConversation: true,
    hasTarget: true,
    unavailable: false,
    policyUnavailable: true,
  },
  {
    label: "following 无关注关系",
    policy: "following",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: true,
  },
  {
    label: "发送者关注收件人不是放行方向",
    policy: "following",
    follow: "sender_to_target",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: true,
  },
  {
    label: "收件人关注发送者才放行",
    policy: "following",
    follow: "target_to_sender",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: false,
  },
  {
    label: "同 ID 的版块关注不能冒充用户关注",
    policy: "following",
    follow: "forum",
    hasTarget: true,
    unavailable: false,
    policyUnavailable: true,
  },
  {
    label: "已有会话 + following 未关注：页面仍不放行",
    policy: "following",
    existingConversation: true,
    hasTarget: true,
    unavailable: false,
    policyUnavailable: true,
  },
  {
    label: "self 不查询目标且两个标志为 false",
    policy: "off",
    to: "self",
    hasTarget: false,
    unavailable: false,
    policyUnavailable: false,
  },
  {
    label: "missing 只标记目标不可用",
    to: "missing",
    hasTarget: false,
    unavailable: true,
    policyUnavailable: false,
  },
  {
    label: "未指定目标不显示任何不可用提示",
    to: "none",
    hasTarget: false,
    unavailable: false,
    policyUnavailable: false,
  },
];

let tdb: TempDb;

describe.skipIf(skipDb)("私信目标可达性 · 页面等价临时库矩阵", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it.each(cases.map((entry, index) => ({ ...entry, targetId: 1_200_000 + index })))(
    "$label",
    async (entry) => {
      const senderId = DEMO.alice;
      const { targetId } = entry;
      await getWebDb()
        .insert(users)
        .values({
          id: targetId,
          username: `e2e_reachability_${targetId}`,
          usernameKey: `e2e_reachability_${targetId}`,
          state: entry.state ?? "active",
          createdAt: sql`NOW()`,
        });
      if (entry.policy !== undefined) {
        await getWebDb().insert(userProfiles).values({ userId: targetId, pmPolicy: entry.policy });
      }
      if (entry.closure !== undefined) {
        await getWebDb()
          .insert(accountDeletionRequests)
          .values({
            userId: targetId,
            status: entry.closure,
            requestedAt: sql`NOW()`,
            scheduledAt: sql`NOW() + INTERVAL 30 DAY`,
            completedAt: entry.closure === "completed" ? sql`NOW()` : null,
          });
      }
      if (entry.restriction !== undefined) {
        await getWebDb()
          .insert(userRestrictions)
          .values({
            userId: targetId,
            kind: entry.restriction === "mute" ? "mute" : "ban",
            scopeId: entry.restriction === "scoped_ban" ? 901 : 0,
            reason: entry.label,
            startsAt:
              entry.restriction === "future_ban"
                ? sql`NOW() + INTERVAL 1 DAY`
                : sql`NOW() - INTERVAL 2 DAY`,
            endsAt: entry.restriction === "expired_ban" ? sql`NOW() - INTERVAL 1 DAY` : null,
            createdAt: sql`NOW()`,
          });
      }
      if (entry.follow !== undefined) {
        await getWebDb()
          .insert(follows)
          .values({
            userId: entry.follow === "sender_to_target" ? senderId : targetId,
            targetId: entry.follow === "sender_to_target" ? targetId : senderId,
            targetType: entry.follow === "forum" ? "forum" : "user",
            createdAt: sql`NOW()`,
          });
      }
      if (entry.existingConversation) {
        const [conversation] = await getWebDb()
          .insert(conversations)
          .values({
            pairKey: `${senderId}:${targetId}`,
            createdAt: sql`NOW()`,
          });
        await getWebDb()
          .insert(conversationMembers)
          .values([
            { conversationId: conversation.insertId, userId: senderId },
            { conversationId: conversation.insertId, userId: targetId },
          ]);
      }

      const to =
        entry.to === "self"
          ? senderId
          : entry.to === "missing"
            ? 2_000_000
            : entry.to === "none"
              ? null
              : targetId;
      expect(await messageTargetReachability(senderId, to)).toEqual({
        target: entry.hasTarget
          ? {
              id: targetId,
              state: entry.state ?? "active",
              pmPolicy: entry.policy ?? null,
            }
          : undefined,
        targetUnavailable: entry.unavailable,
        targetPolicyUnavailable: entry.policyUnavailable,
      });
    },
  );
});
