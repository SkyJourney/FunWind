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
import { digestMail } from "@/lib/auth/mailer";
import { APP_URL } from "@/lib/site";

/**
 * S7 每日汇总（docs/EMAIL-SCENARIOS.md 第三期）：给「开了 email 汇总偏好 + 有邮箱 + 24h 未活跃」的用户
 * 发一封动态摘要（未读私信/新回复/提及/新关注者，取自未读通知行），并更新 users.last_email_digest_at。
 * 由 scripts/digest-cron.mts 在每天配置的时刻调用（--force-user 供测试/手动触发）。
 */

const DIGEST_TYPES = ["post.replied", "post.reply_to", "post.mentioned", "user.followed"];

export interface DigestResult {
  checked: number;
  sent: number;
  skippedActive: number;
  skippedNoEmail: number;
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

export async function runDigestOnce(opts: { onlyUserId?: number } = {}): Promise<DigestResult> {
  const result: DigestResult = { checked: 0, sent: 0, skippedActive: 0, skippedNoEmail: 0 };
  const optIn = await digestOptInUserIds();
  const candidates = opts.onlyUserId ? optIn.filter((id) => id === opts.onlyUserId) : optIn;

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

    const sent = await sendUserEmail(userId, ({ siteName, siteUrl }) =>
      digestMail(
        {
          siteUrl: siteUrl || APP_URL,
          unreadPm,
          newReplies,
          newMentions,
          newFollowers,
        },
        siteName,
      ),
    );
    if (sent) {
      result.sent++;
      await getWebDb()
        .update(users)
        .set({ lastEmailDigestAt: sql`NOW()` })
        .where(eq(users.id, userId));
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
