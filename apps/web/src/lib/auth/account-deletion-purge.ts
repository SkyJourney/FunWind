import "server-only";

import { and, eq, or, sql } from "drizzle-orm";
import {
  accountDeletionTokens,
  announcementReads,
  auditLog,
  checkins,
  emailTokens,
  eventLog,
  eventOutbox,
  follows,
  gateUnlocks,
  inviteCodes,
  messages,
  notificationPreferences,
  notifications,
  pollOptions,
  pollVotes,
  polls,
  reactions,
  reports,
  sessions,
  userAppeals,
  userBadges,
  userProfiles,
  userRestrictions,
  userRoles,
  userStats,
  users,
} from "@funwind/db";
import type { DbTx } from "@/lib/audit";
import { deletePointAccountInTx } from "@/lib/points/account";
import { deleteUserUploadHistoryInTx } from "@/lib/uploads/store";

/** 原事务内先回退选项票数，再按投票去重回退人数；投票行由后续 purge 按原序删除。 */
export async function revertUserPollVotes(tx: DbTx, userId: number): Promise<void> {
  const voteRows = await tx
    .select({
      pollId: pollVotes.pollId,
      optionId: pollVotes.optionId,
      count: sql<number>`COUNT(*)`,
    })
    .from(pollVotes)
    .where(eq(pollVotes.userId, userId))
    .groupBy(pollVotes.pollId, pollVotes.optionId);
  const votedPollIds = new Set(voteRows.map((row) => row.pollId));
  for (const vote of voteRows) {
    const count = Number(vote.count);
    await tx
      .update(pollOptions)
      .set({ voteCount: sql`GREATEST(${pollOptions.voteCount} - ${count}, 0)` })
      .where(eq(pollOptions.id, vote.optionId));
  }
  for (const pollId of votedPollIds) {
    await tx
      .update(polls)
      .set({ voterCount: sql`GREATEST(${polls.voterCount} - 1, 0)` })
      .where(eq(polls.id, pollId));
  }
}

/**
 * 沿用调用方已持有的用户与注销申请锁，在同一连接按既有清单清理或匿名化数据。
 * 不提交事务、不扩大删表；申请完成标记及完成审计由调用方在本函数之后写入。
 */
export async function purgeUserDataInTx(tx: DbTx, userId: number): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.userId, userId));
  await tx.delete(emailTokens).where(eq(emailTokens.userId, userId));
  await tx.delete(accountDeletionTokens).where(eq(accountDeletionTokens.userId, userId));
  await tx.delete(userRoles).where(eq(userRoles.userId, userId));
  await tx.delete(userRestrictions).where(eq(userRestrictions.userId, userId));
  await tx.delete(userBadges).where(eq(userBadges.userId, userId));
  await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  await tx.delete(announcementReads).where(eq(announcementReads.userId, userId));
  await tx.delete(checkins).where(eq(checkins.userId, userId));
  await deletePointAccountInTx(tx, userId);
  await tx.delete(userStats).where(eq(userStats.userId, userId));
  await deleteUserUploadHistoryInTx(tx, userId);
  await tx.delete(gateUnlocks).where(eq(gateUnlocks.userId, userId));
  await tx.delete(reactions).where(eq(reactions.userId, userId));
  await tx.delete(pollVotes).where(eq(pollVotes.userId, userId));
  await tx
    .delete(follows)
    .where(
      or(
        eq(follows.userId, userId),
        and(eq(follows.targetType, "user"), eq(follows.targetId, userId)),
      ),
    );
  await tx.delete(notifications).where(eq(notifications.userId, userId));
  await tx
    .update(notifications)
    .set({ actorId: null, data: null })
    .where(eq(notifications.actorId, userId));
  await tx.update(inviteCodes).set({ createdBy: null }).where(eq(inviteCodes.createdBy, userId));
  await tx.update(inviteCodes).set({ usedBy: null }).where(eq(inviteCodes.usedBy, userId));
  await tx.update(reports).set({ reason: "" }).where(eq(reports.reporterId, userId));
  await tx.update(reports).set({ handledNote: null }).where(eq(reports.handledBy, userId));
  await tx
    .update(userAppeals)
    .set({ reason: "已匿名化", result: null })
    .where(eq(userAppeals.userId, userId));
  await tx.delete(userProfiles).where(eq(userProfiles.userId, userId));

  await tx
    .update(auditLog)
    .set({ beforeJson: null, afterJson: null, ip: null })
    .where(
      or(
        eq(auditLog.actorId, userId),
        and(eq(auditLog.targetType, "user"), eq(auditLog.targetId, String(userId))),
        sql`JSON_CONTAINS(${auditLog.beforeJson}, CAST(${userId} AS JSON))`,
        sql`JSON_CONTAINS(${auditLog.afterJson}, CAST(${userId} AS JSON))`,
      ),
    );
  await tx
    .update(eventLog)
    .set({ payload: { redacted: true }, errorJson: null })
    .where(
      or(
        eq(eventLog.actorId, userId),
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('userId', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('authorId', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('senderId', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('recipientId', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('operatorId', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('editorId', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('mentionedUserId', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('createdBy', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('uploaderId', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('threadAuthorId', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('replyToAuthorId', ${userId}))`,
        sql`JSON_CONTAINS(${eventLog.payload}, JSON_OBJECT('targetType', 'user', 'targetId', ${userId}))`,
      ),
    );
  await tx
    .delete(eventOutbox)
    .where(
      or(
        eq(eventOutbox.actorId, userId),
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('userId', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('authorId', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('senderId', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('recipientId', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('operatorId', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('editorId', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('mentionedUserId', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('createdBy', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('uploaderId', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('threadAuthorId', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('replyToAuthorId', ${userId}))`,
        sql`JSON_CONTAINS(${eventOutbox.payload}, JSON_OBJECT('targetType', 'user', 'targetId', ${userId}))`,
      ),
    );
  await tx.update(messages).set({ senderId: null }).where(eq(messages.senderId, userId));
  await tx
    .update(users)
    .set({
      username: `已注销用户#${userId}`,
      usernameKey: `deleted:${userId}`,
      email: null,
      emailKey: null,
      passwordHash: null,
      legacyPasswordHash: null,
      legacyPasswordPending: false,
      emailVerifiedAt: null,
      emailVerificationRequired: false,
      loginVerificationRequired: false,
      lastLoginAt: null,
      lastEmailDigestAt: null,
      state: "deleted",
    })
    .where(eq(users.id, userId));
}
