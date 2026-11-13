import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  conversationMembers,
  getWebDb,
  messages,
  notificationPreferences,
  notifications,
  users,
} from "@funwind/db";
import { sendUserEmail } from "@/lib/notifications/email";
import { digestMail } from "@/lib/mail";
import { nowBeijingWallTime } from "@/lib/datetime";

/**
 * S7 每日汇总（docs/EMAIL-SCENARIOS.md 第三期）：给「开了 email 汇总偏好 + 有邮箱 + 24h 未活跃」的用户
 * 发一封动态摘要（未读私信/新回复/提及/新关注者，取自未读通知行），并更新 users.last_email_digest_at。
 * 由进程内调度器的 email.digest 任务每小时比对后台配置时刻后调用（M17 Step 1 接线）；
 * scripts/digest-cron.mts 保留为手动/测试入口，与调度器共用同一任务与同一把命名锁。
 *
 * **当日幂等（M17 Step 1）**：同一北京日内只发一封。此前缺这道闸，而未读私信计数不受 `since`
 * 时间窗约束（只按 last_read_message_id 过滤），所以同日第二次运行会给有未读私信的用户**再发一封**——
 * 这正是 docs/SCHEDULED-JOBS.md 当初记载「系统 cron 与进程内调度同时跑可能重复发信、本期不迁」的实质原因。
 * 补上当日闸后该顾虑消除，digest 才能安全接进调度器（命名锁只防并发，不防先后双跑）。
 */

const DIGEST_TYPES = ["post.replied", "post.reply_to", "post.mentioned", "user.followed"];

export interface DigestResult {
  checked: number;
  sent: number;
  skippedActive: number;
  skippedNoEmail: number;
  /** 当日已发过而跳过（当日幂等闸） */
  skippedToday: number;
  /** 发送失败（sendUserEmail 返回 false）；此前静默丢弃，任务摘要无法反映部分失败 */
  failed: number;
}

/** digest 偏好行约定：type="email.digest"、channel=email、enabled=true */
export async function digestOptInUserIds(): Promise<number[]> {
  const rows = await getWebDb()
    .select({ userId: notificationPreferences.userId })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.type, "email.digest"),
        eq(notificationPreferences.channel, "email"),
        eq(notificationPreferences.enabled, true),
      ),
    );
  return rows.map((r) => r.userId);
}

export async function runDigestOnce(
  opts: { onlyUserId?: number; force?: boolean } = {},
): Promise<DigestResult> {
  const result: DigestResult = {
    checked: 0,
    sent: 0,
    skippedActive: 0,
    skippedNoEmail: 0,
    skippedToday: 0,
    failed: 0,
  };
  const optIn = await digestOptInUserIds();
  const candidates = opts.onlyUserId ? optIn.filter((id) => id === opts.onlyUserId) : optIn;
  // 北京当日（与库内 DATETIME 同语义）；force 供手动补发/测试绕过当日闸
  const today = nowBeijingWallTime().slice(0, 10);

  for (const userId of candidates) {
    result.checked++;
    const [user] = await getWebDb()
      .select({
        email: users.email,
        state: users.state,
        lastLoginAt: users.lastLoginAt,
        lastDigestAt: users.lastEmailDigestAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || user.state !== "active" || !user.email) {
      result.skippedNoEmail++;
      continue;
    }
    // 当日幂等闸：同一北京日已发过就不再发（调度器与手动脚本先后双跑也安全）
    if (!opts.force && user.lastDigestAt?.slice(0, 10) === today) {
      result.skippedToday++;
      continue;
    }
    // 24h 内登录过 = 活跃用户，不打扰
    if (
      user.lastLoginAt &&
      Date.now() - new Date(user.lastLoginAt.replace(" ", "T")).getTime() < 24 * 3600_000
    ) {
      result.skippedActive++;
      continue;
    }
    const since = user.lastDigestAt ?? "2000-01-01 00:00:00";

    // 未读私信：成员身份下 conversation_members.last_read_message_id 之后的消息数
    const [pm] = await getWebDb()
      .select({ n: sql<number>`count(*)` })
      .from(conversationMembers)
      .innerJoin(messages, eq(messages.conversationId, conversationMembers.conversationId))
      .where(
        and(
          eq(conversationMembers.userId, userId),
          or(
            isNull(conversationMembers.lastReadMessageId),
            gt(messages.id, conversationMembers.lastReadMessageId),
          ),
          ne(messages.senderId, userId),
        ),
      );
    const unreadPm = Number(pm?.n ?? 0);

    // 通知未读计数（创建于上次 digest 之后的互动类）
    const unreadRows = await getWebDb()
      .select({ type: notifications.type, n: sql<number>`count(*)` })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          gt(notifications.createdAt, since),
          inArray(notifications.type, DIGEST_TYPES),
        ),
      )
      .groupBy(notifications.type);
    const byType = new Map(unreadRows.map((r) => [r.type, Number(r.n)]));
    const newReplies = (byType.get("post.replied") ?? 0) + (byType.get("post.reply_to") ?? 0);
    const newMentions = byType.get("post.mentioned") ?? 0;
    const newFollowers = byType.get("user.followed") ?? 0;

    if (unreadPm === 0 && newReplies === 0 && newMentions === 0 && newFollowers === 0) {
      // 无动态也刷新时间戳，避免积压
      await getWebDb()
        .update(users)
        .set({ lastEmailDigestAt: sql`NOW()` })
        .where(eq(users.id, userId));
      continue;
    }

    const sent = await sendUserEmail(userId, ({ brand }) =>
      digestMail({ unreadPm, newReplies, newMentions, newFollowers }, brand),
    );
    if (sent) {
      result.sent++;
      await getWebDb()
        .update(users)
        .set({ lastEmailDigestAt: sql`NOW()` })
        .where(eq(users.id, userId));
    } else {
      // 发送失败不写时间戳（下一轮可重试），但要计数——否则任务摘要看不出部分失败
      result.failed++;
    }
  }
  return result;
}

// 供 E2E/调试直查（最近一条 digest 记录）
export async function lastDigestDebug() {
  return getWebDb()
    .select({ id: users.id, at: users.lastEmailDigestAt })
    .from(users)
    .orderBy(desc(users.lastEmailDigestAt))
    .limit(1);
}
