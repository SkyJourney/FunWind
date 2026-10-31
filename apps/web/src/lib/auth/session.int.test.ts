// @vitest-environment node
/**
 * 会话的真实 MySQL 集成测试（临时库）。next/headers 的 cookies() 用内存 cookie 罐替身，其余全是真实代码与真实数据库。
 * 覆盖：令牌只存哈希、读取条件（过期/已注销/封禁）、活跃时间记录与 30 天绝对过期、登录轮换、登出与全部吊销。
 */
import { and, eq, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  auditLog,
  DEMO,
  emailTokens,
  getWebDb,
  sessions,
  userRestrictions,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

// 内存 cookie 罐：模拟 Next 的 cookies() 存储
const jar = new Map<string, { value: string; opts?: Record<string, unknown> }>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, opts?: Record<string, unknown>) =>
      void jar.set(name, { value, opts }),
    delete: (name: string) => void jar.delete(name),
  }),
}));

import { getCurrentSubject } from "@/lib/authz/subject";
import { generateToken, hashToken } from "./token";
import { issueEmailToken, peekEmailTokenUserId } from "./tokens";
import {
  MUST_CHANGE_COOKIE,
  SESSION_COOKIE,
  SessionCreationError,
  createLegacyPasswordChangeSession,
  createSession,
  destroyCurrentSession,
  getCurrentUser,
  getPasswordChangeUser,
  replaceCredentialsAndCreateSession,
  replaceCredentialsAndCreateSessionWithEmailToken,
  revokeAllForUser,
  revokeOtherSessions,
} from "./session";

let tdb: TempDb;
const db = () => getWebDb();
const rows = (userId: number) => db().select().from(sessions).where(eq(sessions.userId, userId));

async function insertExistingSession(userId: number) {
  const token = generateToken();
  await db()
    .insert(sessions)
    .values({
      id: hashToken(token),
      userId,
      createdAt: sql`NOW()`,
      expiresAt: sql`NOW() + INTERVAL 1 DAY`,
      lastSeenAt: sql`NOW()`,
      ip: null,
      userAgent: null,
    });
  jar.set(SESSION_COOKIE, { value: token });
  return token;
}

describe.skipIf(skipDb)("会话 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });
  beforeEach(async () => {
    jar.clear();
    await db().delete(sessions);
  });

  describe("createSession", () => {
    it("库里只存令牌的 SHA-256；cookie 里是明文令牌，httpOnly + lax，带 IP / UA", async () => {
      await createSession(DEMO.admin, { ip: "203.0.113.9", userAgent: "UA".repeat(200) });
      const cookie = jar.get(SESSION_COOKIE)!;
      expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookie.opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
      const [row] = await rows(DEMO.admin);
      expect(row?.id).toBe(hashToken(cookie.value));
      expect(row?.id).not.toBe(cookie.value); // 库泄漏 ≠ 会话劫持
      expect(row?.ip).toBe("203.0.113.9");
      expect(row?.userAgent?.length).toBe(255); // UA 截断
    });

    it("IP 未知（null / 缺省）正常入库为空；两次创建得到不同令牌", async () => {
      await createSession(DEMO.member, { ip: null });
      const first = jar.get(SESSION_COOKIE)!.value;
      await createSession(DEMO.member);
      expect(jar.get(SESSION_COOKIE)!.value).not.toBe(first);
      expect((await rows(DEMO.member)).every((r) => r.ip === null)).toBe(true);
    });

    it("凭据轮换：密码更新、旧会话吊销、新会话建立原子提交", async () => {
      const [original] = await db()
        .select({
          passwordHash: users.passwordHash,
          legacy: users.legacyPasswordHash,
          pending: users.legacyPasswordPending,
        })
        .from(users)
        .where(eq(users.id, DEMO.member));
      await insertExistingSession(DEMO.member);
      await insertExistingSession(DEMO.member);
      try {
        const result = await replaceCredentialsAndCreateSession(
          DEMO.member,
          "rotated-test-hash",
          { ip: "203.0.113.8", userAgent: "rotation-test" },
          { auditAction: "test.password.rotate" },
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const sessionRows = await rows(DEMO.member);
        expect(sessionRows).toHaveLength(1);
        expect(sessionRows[0]?.id).toBe(hashToken(result.sessionToken));
        const [user] = await db()
          .select({ passwordHash: users.passwordHash, legacy: users.legacyPasswordHash })
          .from(users)
          .where(eq(users.id, DEMO.member));
        expect(user).toEqual({ passwordHash: "rotated-test-hash", legacy: null });
        const [audit] = await db()
          .select({ before: auditLog.beforeJson, after: auditLog.afterJson })
          .from(auditLog)
          .where(eq(auditLog.action, "test.password.rotate"));
        expect(audit?.before).toMatchObject({ passwordConfigured: true });
        expect(audit?.after).toEqual({
          passwordConfigured: true,
          legacyPasswordPending: false,
          via: "self",
        });
        expect(JSON.stringify(audit?.after)).not.toContain("rotated-test-hash");
      } finally {
        if (original) {
          await db()
            .update(users)
            .set({
              passwordHash: original.passwordHash,
              legacyPasswordHash: original.legacy,
              legacyPasswordPending: original.pending,
            })
            .where(eq(users.id, DEMO.member));
        }
      }
    });

    it("reset 令牌消费与密码轮换共事务，轮换失败会保留令牌", async () => {
      const [original] = await db()
        .select({
          passwordHash: users.passwordHash,
          legacy: users.legacyPasswordHash,
          pending: users.legacyPasswordPending,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.id, DEMO.member));
      const token = await issueEmailToken(DEMO.member, "reset");
      const tokenId = hashToken(token);
      try {
        await expect(
          replaceCredentialsAndCreateSessionWithEmailToken(
            token,
            "reset",
            "x".repeat(300),
            {},
            { auditAction: "test.password.reset_email_token_failed" },
          ),
        ).rejects.toThrow();
        expect(await peekEmailTokenUserId(token, "reset")).toBe(DEMO.member);

        const result = await replaceCredentialsAndCreateSessionWithEmailToken(
          token,
          "reset",
          "email-token-rotation-hash",
          { ip: "203.0.113.10", userAgent: "atomic-token-test" },
          { auditAction: "test.password.reset_email_token" },
        );
        expect(result).toMatchObject({ ok: true, userId: DEMO.member });
        if (!result.ok) return;
        expect(await peekEmailTokenUserId(token, "reset")).toBeNull();
        expect(await rows(DEMO.member)).toHaveLength(1);
        const [updated] = await db()
          .select({ passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, DEMO.member));
        expect(updated?.passwordHash).toBe("email-token-rotation-hash");
      } finally {
        await db().delete(sessions).where(eq(sessions.userId, DEMO.member));
        await db().delete(emailTokens).where(eq(emailTokens.id, tokenId));
        if (original) {
          await db()
            .update(users)
            .set({
              passwordHash: original.passwordHash,
              legacyPasswordHash: original.legacy,
              legacyPasswordPending: original.pending,
              emailVerifiedAt: original.emailVerifiedAt,
            })
            .where(eq(users.id, DEMO.member));
        }
      }
    });

    it("封禁态密码重置仍原子吊销旧会话，但不签发新会话", async () => {
      const [original] = await db()
        .select({
          passwordHash: users.passwordHash,
          legacy: users.legacyPasswordHash,
          pending: users.legacyPasswordPending,
        })
        .from(users)
        .where(eq(users.id, DEMO.member));
      const reason = "重置边界回归";
      await insertExistingSession(DEMO.member);
      await db().insert(userRestrictions).values({
        userId: DEMO.member,
        kind: "ban",
        scopeId: 0,
        reason,
        startsAt: "2000-01-01 00:00:00",
        endsAt: null,
        createdAt: "2000-01-01 00:00:00",
      });

      try {
        const result = await replaceCredentialsAndCreateSession(
          DEMO.member,
          "reset-under-ban",
          {},
          { auditAction: "test.password.reset_under_ban" },
        );
        expect(result).toEqual({ ok: false, code: "banned" });
        expect(await rows(DEMO.member)).toHaveLength(0);
        const [user] = await db()
          .select({ passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, DEMO.member));
        expect(user?.passwordHash).toBe("reset-under-ban");
        const [audit] = await db()
          .select({ after: auditLog.afterJson })
          .from(auditLog)
          .where(eq(auditLog.action, "test.password.reset_under_ban"));
        expect(audit?.after).toMatchObject({ passwordConfigured: true, via: "self" });
        expect(JSON.stringify(audit?.after)).not.toContain("reset-under-ban");
      } finally {
        await db()
          .delete(userRestrictions)
          .where(
            and(eq(userRestrictions.userId, DEMO.member), eq(userRestrictions.reason, reason)),
          );
        if (original) {
          await db()
            .update(users)
            .set({
              passwordHash: original.passwordHash,
              legacyPasswordHash: original.legacy,
              legacyPasswordPending: original.pending,
            })
            .where(eq(users.id, DEMO.member));
        }
      }
    });
  });

  describe("getCurrentUser", () => {
    it("无 cookie / cookie 无效 → null", async () => {
      expect(await getCurrentUser()).toBeNull();
      jar.set(SESSION_COOKIE, { value: "not-a-real-token" });
      expect(await getCurrentUser()).toBeNull();
    });

    it("有效会话 → 用户信息（邮箱验证态、是否设置密码）", async () => {
      await createSession(DEMO.admin);
      const u = await getCurrentUser();
      expect(u).toMatchObject({
        id: DEMO.admin,
        username: "demo_admin",
        passwordHashIsSet: true,
        emailVerified: false,
      });
      // 无密码的演示用户（等待认领）
      jar.clear();
      await createSession(DEMO.alice);
      expect((await getCurrentUser())?.passwordHashIsSet).toBe(false);
    });

    it("旧密码待换新只开放专用会话；数据库标记清除后同一 session 才转为普通登录态", async () => {
      await db()
        .update(users)
        .set({ legacyPasswordPending: true, legacyPasswordHash: "test-legacy" })
        .where(eq(users.id, DEMO.member));
      await expect(createSession(DEMO.member)).rejects.toMatchObject({
        code: "password_change_required",
      });

      await createLegacyPasswordChangeSession(DEMO.member);
      expect(await getCurrentUser()).toBeNull();
      expect(await getCurrentSubject()).toMatchObject({ userId: null });
      expect(await getPasswordChangeUser()).toMatchObject({ id: DEMO.member });

      await db()
        .update(users)
        .set({ legacyPasswordPending: false, legacyPasswordHash: null })
        .where(eq(users.id, DEMO.member));
      expect(await getCurrentUser()).toMatchObject({ id: DEMO.member });
      await db().delete(sessions).where(eq(sessions.userId, DEMO.member));
    });

    it("注销申请中使普通会话失效，并禁止建立新会话", async () => {
      await createSession(DEMO.team);
      await db()
        .insert(accountDeletionRequests)
        .values({
          userId: DEMO.team,
          status: "pending",
          requestedAt: sql`NOW()`,
          scheduledAt: sql`NOW() + INTERVAL 30 DAY`,
        });
      expect(await getCurrentUser()).toBeNull();
      await expect(createSession(DEMO.team)).rejects.toMatchObject({ code: "account_closing" });
      await db()
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.userId, DEMO.team));
      await db().delete(sessions).where(eq(sessions.userId, DEMO.team));
    });

    it("会话过期 → null", async () => {
      await createSession(DEMO.team);
      await db().execute(
        sql`UPDATE sessions SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE user_id = ${DEMO.team}`,
      );
      expect(await getCurrentUser()).toBeNull();
    });

    it("已注销 tombstone 使所有旧会话永久失效，即使 state 被误恢复也不能复活", async () => {
      await createSession(DEMO.xiaoyi);
      expect(await getCurrentUser()).not.toBeNull();
      await db().update(users).set({ state: "deleted" }).where(eq(users.id, DEMO.xiaoyi));
      await db()
        .insert(accountDeletionRequests)
        .values({
          userId: DEMO.xiaoyi,
          status: "completed",
          requestedAt: sql`NOW()`,
          scheduledAt: sql`NOW()`,
          completedAt: sql`NOW()`,
        });
      expect(await getCurrentUser()).toBeNull();
      await db().update(users).set({ state: "active" }).where(eq(users.id, DEMO.xiaoyi));
      expect(await getCurrentUser()).toBeNull();
      await expect(createSession(DEMO.xiaoyi)).rejects.toMatchObject({ code: "account_closing" });
      await db()
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.userId, DEMO.xiaoyi));
      await db().delete(sessions).where(eq(sessions.userId, DEMO.xiaoyi));
    });

    it("未在封禁期间读取的旧会话，在全站 ban 到期后也不会复活", async () => {
      await createSession(DEMO.member);
      await db().execute(
        sql`UPDATE sessions SET created_at = NOW() - INTERVAL 1 HOUR WHERE user_id = ${DEMO.member}`,
      );
      await db()
        .insert(userRestrictions)
        .values({
          userId: DEMO.member,
          kind: "ban",
          scopeId: 0,
          reason: "历史封禁",
          startsAt: sql`NOW() - INTERVAL 30 MINUTE`,
          endsAt: sql`NOW() - INTERVAL 10 MINUTE`,
          createdAt: sql`NOW() - INTERVAL 30 MINUTE`,
        });

      expect(await getCurrentUser()).toBeNull();
      expect(await rows(DEMO.member)).toHaveLength(0);
    });

    it("新会话创建时恰好处于全站 ban 结束时刻，不视为封禁期间旧会话", async () => {
      const endsAt = "2000-02-01 00:00:00";
      await db().insert(userRestrictions).values({
        userId: DEMO.xiaoyi,
        kind: "ban",
        scopeId: 0,
        reason: "结束边界回归",
        startsAt: "2000-01-01 00:00:00",
        endsAt,
        createdAt: "2000-01-01 00:00:00",
      });
      await createSession(DEMO.xiaoyi);
      await db()
        .update(sessions)
        .set({ createdAt: endsAt })
        .where(eq(sessions.userId, DEMO.xiaoyi));
      expect(await getCurrentUser()).toMatchObject({ id: DEMO.xiaoyi });
    });

    it("全站封禁生效 → 会话失效；封禁到期或仅版块级禁言 → 仍有效", async () => {
      await expect(createSession(DEMO.banned)).rejects.toBeInstanceOf(SessionCreationError);
      await insertExistingSession(DEMO.banned); // 模拟封禁前已经建立的 session
      expect(await getCurrentUser()).toBeNull();

      jar.clear();
      await createSession(DEMO.member);
      const ban = (over: Record<string, unknown>) =>
        db()
          .insert(userRestrictions)
          .values({
            userId: DEMO.member,
            kind: "ban",
            scopeId: 0,
            reason: "测试",
            startsAt: "2000-01-01 00:00:00",
            createdAt: "2000-01-01 00:00:00",
            ...over,
          });
      await ban({ endsAt: "2000-02-01 00:00:00" }); // 已结束
      await db().insert(userRestrictions).values({
        userId: DEMO.member,
        kind: "mute",
        scopeId: 0,
        startsAt: "2000-01-01 00:00:00",
        createdAt: "2000-01-01 00:00:00",
      });
      expect(await getCurrentUser()).not.toBeNull();
      await ban({ endsAt: null }); // 永久
      expect(await getCurrentUser()).toBeNull();
    });

    it("活跃时间：超过 1 小时未活动才更新 last_seen_at（避免写放大）", async () => {
      await createSession(DEMO.admin);
      const id = hashToken(jar.get(SESSION_COOKIE)!.value);
      const seen = async () =>
        (await db().select().from(sessions).where(eq(sessions.id, id)))[0]!.lastSeenAt;

      const fresh = await seen();
      await getCurrentUser();
      expect(await seen()).toBe(fresh); // 刚创建：不更新

      await db().execute(
        sql`UPDATE sessions SET last_seen_at = NOW() - INTERVAL 2 HOUR WHERE id = ${id}`,
      );
      const stale = await seen();
      await getCurrentUser();
      expect(await seen()).not.toBe(stale);
    });

    it("30 天绝对过期：活跃使用不延长 expires_at（与 cookie maxAge 一致；真正的滑动续期需要中间件，暂不做）", async () => {
      await createSession(DEMO.admin);
      const id = hashToken(jar.get(SESSION_COOKIE)!.value);
      const expires = async () =>
        (await db().select().from(sessions).where(eq(sessions.id, id)))[0]!.expiresAt;
      const before = await expires();
      await db().execute(
        sql`UPDATE sessions SET last_seen_at = NOW() - INTERVAL 2 HOUR WHERE id = ${id}`,
      );
      expect(await getCurrentUser()).not.toBeNull(); // 触发了活跃时间更新
      expect(await expires()).toBe(before); // 有效期没有被顺延
    });
  });

  describe("getCurrentSubject（会话 → 权限主体）", () => {
    it("未登录是游客主体；登录后带上该用户的角色绑定", async () => {
      expect((await getCurrentSubject()).userId).toBeNull();
      await createSession(DEMO.admin);
      const s = await getCurrentSubject();
      expect(s.userId).toBe(DEMO.admin);
      expect(s.roles.map((r) => r.key)).toContain("admin");
    });
  });

  describe("登出与吊销", () => {
    it("destroyCurrentSession：只删当前设备会话并清快门 cookie，不影响其他设备", async () => {
      await destroyCurrentSession(); // 无 cookie：不抛
      await createSession(DEMO.alice);
      const otherToken = jar.get(SESSION_COOKIE)!.value;
      await createSession(DEMO.alice);
      const currentToken = jar.get(SESSION_COOKIE)!.value;
      const currentId = hashToken(currentToken);
      jar.set(MUST_CHANGE_COOKIE, { value: "1" });

      await destroyCurrentSession();
      expect(jar.has(SESSION_COOKIE)).toBe(false);
      expect(jar.has(MUST_CHANGE_COOKIE)).toBe(false);
      expect(await db().select().from(sessions).where(eq(sessions.id, currentId))).toHaveLength(0);
      expect(await rows(DEMO.alice)).toHaveLength(1);
      jar.set(SESSION_COOKIE, { value: otherToken });
      expect((await getCurrentUser())?.id).toBe(DEMO.alice);
    });

    it("revokeAllForUser：该用户全部会话立即失效，不影响他人", async () => {
      await createSession(DEMO.admin);
      const adminToken = jar.get(SESSION_COOKIE)!.value;
      await createSession(DEMO.admin); // 同一用户第二个设备
      await createSession(DEMO.team);
      const teamToken = jar.get(SESSION_COOKIE)!.value;

      await revokeAllForUser(DEMO.admin);
      expect(await rows(DEMO.admin)).toHaveLength(0);
      jar.set(SESSION_COOKIE, { value: adminToken });
      expect(await getCurrentUser()).toBeNull();
      jar.set(SESSION_COOKIE, { value: teamToken });
      expect((await getCurrentUser())?.id).toBe(DEMO.team);
    });

    it("revokeOtherSessions：保留当前设备并撤销同账号其他 session", async () => {
      await createSession(DEMO.admin);
      const otherToken = jar.get(SESSION_COOKIE)!.value;
      await createSession(DEMO.admin);
      const currentToken = jar.get(SESSION_COOKIE)!.value;
      await createSession(DEMO.team);
      const teamToken = jar.get(SESSION_COOKIE)!.value;
      jar.set(SESSION_COOKIE, { value: currentToken });

      await revokeOtherSessions(DEMO.admin);
      expect(await rows(DEMO.admin)).toHaveLength(1);
      jar.set(SESSION_COOKIE, { value: otherToken });
      expect(await getCurrentUser()).toBeNull();
      jar.set(SESSION_COOKIE, { value: currentToken });
      expect((await getCurrentUser())?.id).toBe(DEMO.admin);
      jar.set(SESSION_COOKIE, { value: teamToken });
      expect((await getCurrentUser())?.id).toBe(DEMO.team);
    });
  });
});
