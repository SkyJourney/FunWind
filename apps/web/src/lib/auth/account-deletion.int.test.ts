// @vitest-environment node
import "@/modules";
import { and, eq, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  accountDeletionTokens,
  auditLog,
  conversationMembers,
  conversations,
  DEMO,
  emailTokens,
  follows,
  getWebDb,
  messages,
  notificationPreferences,
  notifications,
  pointAccounts,
  pointLedger,
  pollOptions,
  pollVotes,
  polls,
  sessions,
  threads,
  userBadges,
  userProfiles,
  userRestrictions,
  userRoles,
  userStats,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./password";
import { hashToken } from "./token";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

const jar = new Map<string, { value: string; opts?: Record<string, unknown> }>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, opts?: Record<string, unknown>) =>
      void jar.set(name, { value, opts }),
    delete: (name: string) => void jar.delete(name),
  }),
}));

import {
  cancelAccountDeletion,
  consumeAccountDeletionEmailToken,
  issueAccountDeletionAccessForEmail,
  issueAccountDeletionEmailToken,
  issueAccountDeletionRequestForEmail,
  processDueAccountDeletions,
  requestAccountDeletionWithPassword,
  startOrOpenAccountDeletionWithPassword,
} from "./account-deletion";
import {
  CLOSURE_ACCESS_COOKIE,
  getClosureAccess,
  getCurrentUser,
  SESSION_COOKIE,
  createSession,
} from "./session";
import { conversationList, messagesBefore, unreadPmTotal } from "@/lib/pm/queries";
import { conversationMessages } from "@/lib/pm/service";

let tdb: TempDb;
const db = () => getWebDb();
const PASSWORD = "M9.6-Closure-Password-42";

beforeAll(async () => {
  tdb = await setupTempDb();
  await db()
    .update(users)
    .set({
      passwordHash: await hashPassword(PASSWORD),
      legacyPasswordHash: null,
      legacyPasswordPending: false,
    })
    .where(eq(users.id, DEMO.member));
  await db()
    .update(users)
    .set({ passwordHash: await hashPassword(PASSWORD), legacyPasswordPending: false })
    .where(eq(users.id, DEMO.admin));
  await db()
    .update(users)
    .set({
      email: "closure-alice@example.com",
      emailKey: "closure-alice@example.com",
      emailVerifiedAt: sql`NOW()`,
      passwordHash: null,
      legacyPasswordHash: null,
      legacyPasswordPending: false,
      emailVerificationRequired: true,
      state: "active",
    })
    .where(eq(users.id, DEMO.alice));
});

afterAll(async () => {
  await tdb?.teardown();
});

beforeEach(async () => {
  jar.clear();
  await db().delete(sessions);
});

describe.skipIf(skipDb)("账号注销生命周期 · 真实 MySQL", () => {
  it("不能让最后一位有效站点管理员申请注销", async () => {
    await expect(
      requestAccountDeletionWithPassword({ userId: DEMO.admin }, PASSWORD),
    ).rejects.toMatchObject({ code: "last_admin" });
    await expect(
      startOrOpenAccountDeletionWithPassword("demo_admin", PASSWORD, null),
    ).rejects.toMatchObject({ code: "last_admin" });
    expect(
      await db()
        .select()
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.userId, DEMO.admin),
            eq(accountDeletionRequests.status, "pending"),
          ),
        ),
    ).toHaveLength(0);
  });

  it("密码再确认申请会吊销所有设备；撤销后只新建一个会话，旧 cookie 不复活", async () => {
    expect(await getClosureAccess()).toBeNull();
    expect(await cancelAccountDeletion("no-such-access-token")).toBeNull();
    await createSession(DEMO.member, { userAgent: "device-a" });
    const oldA = jar.get(SESSION_COOKIE)!.value;
    await createSession(DEMO.member, { userAgent: "device-b" });
    const oldB = jar.get(SESSION_COOKIE)!.value;
    expect(await db().select().from(sessions).where(eq(sessions.userId, DEMO.member))).toHaveLength(
      2,
    );

    await expect(
      requestAccountDeletionWithPassword({ userId: DEMO.member }, "wrong-password"),
    ).rejects.toMatchObject({ code: "password_invalid" });
    expect(await db().select().from(sessions).where(eq(sessions.userId, DEMO.member))).toHaveLength(
      2,
    );

    const request = await requestAccountDeletionWithPassword(
      { userId: DEMO.member, ip: "203.0.113.12" },
      PASSWORD,
    );
    expect(await db().select().from(sessions).where(eq(sessions.userId, DEMO.member))).toHaveLength(
      0,
    );
    expect(await getCurrentUser()).toBeNull();
    expect(Date.parse(request.scheduledAt.replace(" ", "T"))).toBeGreaterThan(
      Date.now() + 29 * 86400_000,
    );
    const [stored] = await db()
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, request.requestId));
    expect(stored).toMatchObject({ status: "pending", verificationMethod: "password" });
    expect(stored.accessTokenHash).toBe(hashToken(request.accessToken));

    jar.set(CLOSURE_ACCESS_COOKIE, { value: request.accessToken });
    expect(await getClosureAccess()).toMatchObject({
      requestId: request.requestId,
      userId: DEMO.member,
      status: "pending",
      canCancel: true,
    });

    const cancelled = await cancelAccountDeletion(request.accessToken, {
      ip: "203.0.113.12",
      userAgent: "new-device",
    });
    expect(cancelled?.userId).toBe(DEMO.member);
    expect(cancelled?.sessionToken).toBeTruthy();
    expect(await db().select().from(sessions).where(eq(sessions.userId, DEMO.member))).toHaveLength(
      1,
    );
    const [after] = await db()
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, request.requestId));
    expect(after.status).toBe("cancelled");

    jar.set(SESSION_COOKIE, { value: oldA });
    expect(await getCurrentUser()).toBeNull();
    jar.set(SESSION_COOKIE, { value: oldB });
    expect(await getCurrentUser()).toBeNull();
    jar.set(SESSION_COOKIE, { value: cancelled!.sessionToken! });
    expect(await getCurrentUser()).toMatchObject({ id: DEMO.member });
    expect(await getClosureAccess()).toBeNull();
  });

  it("无普通会话时可用密码开启注销；已有全站封禁时撤销申请也不绕过封禁", async () => {
    const reason = "m9.6-closure-banned-user";
    await expect(
      startOrOpenAccountDeletionWithPassword("demo_member", "incorrect", null),
    ).resolves.toBeNull();
    await db()
      .insert(userRestrictions)
      .values({
        userId: DEMO.member,
        kind: "ban",
        scopeId: 0,
        reason,
        startsAt: sql`NOW()`,
        endsAt: null,
        createdBy: DEMO.admin,
        createdAt: sql`NOW()`,
      });
    try {
      const request = await startOrOpenAccountDeletionWithPassword(
        "demo_member",
        PASSWORD,
        "203.0.113.13",
      );
      expect(request?.started).toBe(true);
      const reopened = await startOrOpenAccountDeletionWithPassword(
        "demo_member",
        PASSWORD,
        "203.0.113.13",
      );
      expect(reopened).toMatchObject({ requestId: request!.requestId, started: false });
      expect(
        await db().select().from(sessions).where(eq(sessions.userId, DEMO.member)),
      ).toHaveLength(0);
      const cancelled = await cancelAccountDeletion(reopened!.accessToken);
      expect(cancelled).toMatchObject({ userId: DEMO.member, sessionToken: null });
      const [row] = await db()
        .select({ status: accountDeletionRequests.status })
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, request!.requestId));
      expect(row.status).toBe("cancelled");
      expect(
        await db().select().from(sessions).where(eq(sessions.userId, DEMO.member)),
      ).toHaveLength(0);
    } finally {
      await db().delete(userRestrictions).where(eq(userRestrictions.reason, reason));
    }
  });

  it("邮箱再验证不泄露未知地址，且只为已验证且符合状态的账号签发", async () => {
    expect(await issueAccountDeletionAccessForEmail("missing@example.com")).toBeNull();
    const [memberBefore] = await db()
      .select({
        email: users.email,
        emailKey: users.emailKey,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, DEMO.member));
    await db()
      .update(users)
      .set({
        email: `closure-${DEMO.member}@example.com`,
        emailKey: `closure-${DEMO.member}@example.com`,
        emailVerifiedAt: sql`NOW()`,
      })
      .where(eq(users.id, DEMO.member));
    try {
      expect(
        await issueAccountDeletionRequestForEmail(`closure-${DEMO.member}@example.com`),
      ).toBeNull();
    } finally {
      await db().update(users).set(memberBefore!).where(eq(users.id, DEMO.member));
    }
    expect(await issueAccountDeletionAccessForEmail("closure-alice@example.com")).toBeNull();
    await expect(issueAccountDeletionEmailToken(DEMO.alice, "access")).rejects.toMatchObject({
      code: "not_eligible",
    });
    const [completed] = (await db()
      .insert(accountDeletionRequests)
      .values({
        userId: DEMO.alice,
        status: "completed",
        requestedAt: sql`NOW()`,
        scheduledAt: sql`NOW()`,
        completedAt: sql`NOW()`,
      })) as unknown as [{ insertId: number }];
    try {
      await expect(issueAccountDeletionEmailToken(DEMO.alice, "request")).rejects.toMatchObject({
        code: "already_completed",
      });
    } finally {
      await db()
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, Number(completed.insertId)));
    }
    const [before] = await db()
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, DEMO.alice));
    await db().update(users).set({ emailVerifiedAt: null }).where(eq(users.id, DEMO.alice));
    try {
      await expect(issueAccountDeletionEmailToken(DEMO.alice, "request")).rejects.toMatchObject({
        code: "email_unverified",
      });
    } finally {
      await db()
        .update(users)
        .set({ emailVerifiedAt: before!.emailVerifiedAt })
        .where(eq(users.id, DEMO.alice));
    }
  });

  it("邮箱再确认只消费一次；到期 worker 幂等匿名化并保留主题、私信和积分台账", async () => {
    await expect(
      requestAccountDeletionWithPassword({ userId: DEMO.alice }, PASSWORD),
    ).rejects.toMatchObject({ code: "password_required" });
    const staleToken = await issueAccountDeletionRequestForEmail("closure-alice@example.com");
    await db()
      .update(users)
      .set({ email: "closure-temp@example.com", emailKey: "closure-temp@example.com" })
      .where(eq(users.id, DEMO.alice));
    expect(await consumeAccountDeletionEmailToken(staleToken!.token)).toBeNull();
    await db()
      .update(users)
      .set({ email: "closure-alice@example.com", emailKey: "closure-alice@example.com" })
      .where(eq(users.id, DEMO.alice));
    const token = await issueAccountDeletionEmailToken(DEMO.alice, "request");
    expect(token?.email).toBe("closure-alice@example.com");
    await createSession(DEMO.alice);
    const oldSession = jar.get(SESSION_COOKIE)!.value;
    const created = await consumeAccountDeletionEmailToken(token!.token);
    expect(created && "scheduledAt" in created).toBe(true);
    if (!created || !("scheduledAt" in created)) throw new Error("注销申请未创建");
    await expect(issueAccountDeletionEmailToken(DEMO.alice, "request")).rejects.toMatchObject({
      code: "already_pending",
    });
    expect(await consumeAccountDeletionEmailToken(token!.token)).toBeNull();
    expect(await db().select().from(sessions).where(eq(sessions.userId, DEMO.alice))).toHaveLength(
      0,
    );
    jar.set(SESSION_COOKIE, { value: oldSession });
    expect(await getCurrentUser()).toBeNull();
    jar.set(CLOSURE_ACCESS_COOKIE, { value: created.accessToken });
    expect(await getClosureAccess()).toMatchObject({ status: "pending", userId: DEMO.alice });
    await db()
      .update(accountDeletionRequests)
      .set({ accessExpiresAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(eq(accountDeletionRequests.id, created.requestId));
    expect(await getClosureAccess()).toBeNull();
    const accessChallenge = await issueAccountDeletionEmailToken(DEMO.alice, "access");
    expect(accessChallenge?.email).toBe("closure-alice@example.com");
    const renewed = await consumeAccountDeletionEmailToken(accessChallenge!.token);
    if (!renewed || "scheduledAt" in renewed) throw new Error("注销状态再认证失败");
    expect(renewed.requestId).toBe(created.requestId);
    expect(await consumeAccountDeletionEmailToken(accessChallenge!.token)).toBeNull();
    jar.set(CLOSURE_ACCESS_COOKIE, { value: renewed.accessToken });
    expect(await getClosureAccess()).toMatchObject({ status: "pending", userId: DEMO.alice });

    const [conversation] = (await db()
      .insert(conversations)
      .values({
        pairKey: `${DEMO.alice}:${DEMO.member}`,
        createdAt: sql`NOW()`,
      })) as unknown as [{ insertId: number }];
    const conversationId = Number(conversation.insertId);
    await db()
      .insert(conversationMembers)
      .values([
        { conversationId, userId: DEMO.alice },
        { conversationId, userId: DEMO.member },
      ]);
    const [message] = (await db()
      .insert(messages)
      .values({
        conversationId,
        senderId: DEMO.alice,
        body: "匿名后仍保留的私信历史",
        createdAt: sql`NOW()`,
      })) as unknown as [{ insertId: number }];
    const [thread] = (await db()
      .insert(threads)
      .values({
        forumId: 901,
        authorId: DEMO.alice,
        title: "匿名后仍保留的主题",
        firstPostId: null,
        state: "visible",
        createdAt: sql`NOW()`,
      })) as unknown as [{ insertId: number }];
    const [poll] = (await db()
      .insert(polls)
      .values({
        threadId: Number(thread.insertId),
        createdBy: DEMO.member,
        voterCount: 1,
        createdAt: sql`NOW()`,
      })) as unknown as [{ insertId: number }];
    const [option] = (await db()
      .insert(pollOptions)
      .values({
        pollId: Number(poll.insertId),
        content: "投票选项",
        voteCount: 1,
        sortOrder: 0,
      })) as unknown as [{ insertId: number }];
    await db()
      .insert(pollVotes)
      .values({
        pollId: Number(poll.insertId),
        optionId: Number(option.insertId),
        userId: DEMO.alice,
        createdAt: sql`NOW()`,
      });
    await db()
      .insert(follows)
      .values([
        {
          userId: DEMO.alice,
          targetType: "user",
          targetId: DEMO.member,
          createdAt: sql`NOW()`,
        },
        {
          userId: DEMO.member,
          targetType: "user",
          targetId: DEMO.alice,
          createdAt: sql`NOW()`,
        },
      ]);
    await db().insert(notificationPreferences).values({
      userId: DEMO.alice,
      type: "post.replied",
      channel: "in_app",
      enabled: true,
    });
    await db()
      .insert(notifications)
      .values({
        userId: DEMO.member,
        category: "interaction",
        type: "user.followed",
        actorId: DEMO.alice,
        targetType: "user",
        targetId: DEMO.alice,
        groupKey: `m9.6-deletion:${DEMO.alice}`,
        data: { username: "closure-alice-private-name" },
        createdAt: sql`NOW()`,
      });
    await db()
      .insert(userProfiles)
      .values({ userId: DEMO.alice, bio: "需要清除的个人介绍", location: "秘密坐标" })
      .onDuplicateKeyUpdate({ set: { bio: "需要清除的个人介绍", location: "秘密坐标" } });
    await db()
      .insert(userStats)
      .values({ userId: DEMO.alice, threadCount: 1, postCount: 1 })
      .onDuplicateKeyUpdate({ set: { threadCount: 1, postCount: 1 } });
    await db()
      .insert(pointAccounts)
      .values({
        userId: DEMO.alice,
        balance: 5,
        lifetimeEarned: 5,
        lifetimeSpent: 0,
        updatedAt: sql`NOW()`,
      })
      .onDuplicateKeyUpdate({ set: { balance: 5, updatedAt: sql`NOW()` } });
    await db()
      .insert(pointLedger)
      .values({
        userId: DEMO.alice,
        delta: 5,
        balanceAfter: 5,
        channel: "earn.test",
        idempotencyKey: "m9-6-account-deletion-preserve-ledger",
        note: "保留的匿名积分账本",
        createdAt: sql`NOW()`,
      });
    await db()
      .insert(auditLog)
      .values({
        actorId: DEMO.alice,
        action: "test.personal.audit",
        targetType: "user",
        targetId: String(DEMO.alice),
        beforeJson: { email: "closure-alice@example.com" },
        afterJson: { profile: "需要清除的个人介绍" },
        ip: "203.0.113.77",
        createdAt: sql`NOW()`,
      });
    await db()
      .update(accountDeletionRequests)
      .set({ scheduledAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(eq(accountDeletionRequests.id, created.requestId));
    await expect(cancelAccountDeletion(renewed.accessToken)).rejects.toMatchObject({
      code: "not_cancellable",
    });

    const result = await processDueAccountDeletions(10);
    expect(result).toEqual({ checked: 1, completed: 1, failed: 0 });
    const [deleted] = await db().select().from(users).where(eq(users.id, DEMO.alice));
    expect(deleted).toMatchObject({
      state: "deleted",
      username: `已注销用户#${DEMO.alice}`,
      usernameKey: `deleted:${DEMO.alice}`,
      email: null,
      emailKey: null,
      passwordHash: null,
      legacyPasswordHash: null,
      emailVerifiedAt: null,
      lastLoginAt: null,
    });
    expect(
      await db().select().from(userProfiles).where(eq(userProfiles.userId, DEMO.alice)),
    ).toHaveLength(0);
    expect(
      await db().select().from(userStats).where(eq(userStats.userId, DEMO.alice)),
    ).toHaveLength(0);
    expect(
      await db().select().from(pointAccounts).where(eq(pointAccounts.userId, DEMO.alice)),
    ).toHaveLength(0);
    expect(await db().select().from(follows).where(eq(follows.userId, DEMO.alice))).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(follows)
        .where(
          and(
            eq(follows.userId, DEMO.member),
            eq(follows.targetType, "user"),
            eq(follows.targetId, DEMO.alice),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await db().select().from(userRoles).where(eq(userRoles.userId, DEMO.alice)),
    ).toHaveLength(0);
    expect(
      await db().select().from(userRestrictions).where(eq(userRestrictions.userId, DEMO.alice)),
    ).toHaveLength(0);
    expect(
      await db().select().from(userBadges).where(eq(userBadges.userId, DEMO.alice)),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, DEMO.alice)),
    ).toHaveLength(0);
    expect(
      await db().select().from(notifications).where(eq(notifications.userId, DEMO.alice)),
    ).toHaveLength(0);
    expect(
      await db().select().from(emailTokens).where(eq(emailTokens.userId, DEMO.alice)),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(accountDeletionTokens)
        .where(eq(accountDeletionTokens.userId, DEMO.alice)),
    ).toHaveLength(0);
    const [actorNotification] = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.groupKey, `m9.6-deletion:${DEMO.alice}`));
    expect(actorNotification).toMatchObject({ actorId: null, data: null });
    expect(
      (
        await db()
          .select()
          .from(threads)
          .where(eq(threads.id, Number(thread.insertId)))
      )[0]?.authorId,
    ).toBe(DEMO.alice);
    expect(
      (
        await db()
          .select()
          .from(messages)
          .where(eq(messages.id, Number(message.insertId)))
      )[0]?.senderId,
    ).toBeNull();
    expect(
      await db()
        .select()
        .from(pointLedger)
        .where(eq(pointLedger.idempotencyKey, "m9-6-account-deletion-preserve-ledger")),
    ).toHaveLength(1);
    expect(
      await db().select().from(pollVotes).where(eq(pollVotes.userId, DEMO.alice)),
    ).toHaveLength(0);
    const [pollAfter] = await db()
      .select()
      .from(polls)
      .where(eq(polls.id, Number(poll.insertId)));
    const [optionAfter] = await db()
      .select()
      .from(pollOptions)
      .where(eq(pollOptions.id, Number(option.insertId)));
    expect(pollAfter?.voterCount).toBe(0);
    expect(optionAfter?.voteCount).toBe(0);
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "test.personal.audit"), eq(auditLog.targetId, String(DEMO.alice))),
      );
    expect(audit).toMatchObject({ beforeJson: null, afterJson: null, ip: null });

    const conversationsAfter = await conversationList(DEMO.member);
    const anonymousConversation = conversationsAfter.find(
      (row) => row.conversationId === conversationId,
    );
    expect(anonymousConversation).toMatchObject({
      otherId: null,
      otherName: "已注销用户",
    });
    expect(anonymousConversation?.unread).toBeGreaterThanOrEqual(1);
    expect(await unreadPmTotal(DEMO.member)).toBe(
      conversationsAfter.reduce((total, conversation) => total + conversation.unread, 0),
    );
    expect(
      (await messagesBefore(conversationId, null)).items.find(
        (row) => row.id === Number(message.insertId),
      )?.senderId,
    ).toBeNull();
    expect(
      (await conversationMessages(conversationId)).items.find(
        (row) => row.id === Number(message.insertId),
      )?.senderId,
    ).toBeNull();
    expect(await processDueAccountDeletions(10)).toEqual({ checked: 0, completed: 0, failed: 0 });
    expect(await getClosureAccess()).toMatchObject({
      status: "completed",
      userId: DEMO.alice,
      canCancel: false,
    });

    await db()
      .update(users)
      .set({ passwordHash: await hashPassword(PASSWORD) })
      .where(eq(users.id, DEMO.alice));
    try {
      await expect(
        startOrOpenAccountDeletionWithPassword(`deleted:${DEMO.alice}`, PASSWORD, null),
      ).resolves.toBeNull();
    } finally {
      await db().update(users).set({ passwordHash: null }).where(eq(users.id, DEMO.alice));
    }
  });

  it("worker 遇到异常数据只记录受控错误码并保留可重试申请", async () => {
    const [created] = (await db()
      .insert(accountDeletionRequests)
      .values({
        userId: 999999999,
        status: "pending",
        requestedAt: sql`NOW() - INTERVAL 31 DAY`,
        scheduledAt: sql`NOW() - INTERVAL 1 DAY`,
      })) as unknown as [{ insertId: number }];
    try {
      expect(await processDueAccountDeletions(1)).toEqual({ checked: 1, completed: 0, failed: 1 });
      const [retry] = await db()
        .select({
          status: accountDeletionRequests.status,
          attemptCount: accountDeletionRequests.attemptCount,
          lastErrorCode: accountDeletionRequests.lastErrorCode,
        })
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, Number(created.insertId)));
      expect(retry).toEqual({
        status: "pending",
        attemptCount: 1,
        lastErrorCode: "processing_failed",
      });
    } finally {
      await db()
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, Number(created.insertId)));
    }
  });
});
