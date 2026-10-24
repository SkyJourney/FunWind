// @vitest-environment node
/**
 * 会话的真实 MySQL 集成测试（临时库）。next/headers 的 cookies() 用内存 cookie 罐替身，其余全是真实代码与真实数据库。
 * 覆盖：令牌只存哈希、读取条件（过期/已注销/封禁）、滑动续期、登录轮换、登出与全部吊销。
 */
import { eq, sql } from "drizzle-orm";
import { DEMO, getWebDb, sessions, userRestrictions, users } from "@funwind/db";
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
import { hashToken } from "./token";
import {
  SESSION_COOKIE,
  createSession,
  destroyCurrentSession,
  getCurrentUser,
  revokeAllForUser,
} from "./session";

let tdb: TempDb;
const db = () => getWebDb();
const rows = (userId: number) => db().select().from(sessions).where(eq(sessions.userId, userId));

describe.skipIf(skipDb)("会话 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });
  beforeEach(() => jar.clear());

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

    it("会话过期 → null", async () => {
      await createSession(DEMO.team);
      await db().execute(
        sql`UPDATE sessions SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE user_id = ${DEMO.team}`,
      );
      expect(await getCurrentUser()).toBeNull();
    });

    it("账号已注销（state=deleted）→ 会话立即失效", async () => {
      await createSession(DEMO.xiaoyi);
      expect(await getCurrentUser()).not.toBeNull();
      await db().update(users).set({ state: "deleted" }).where(eq(users.id, DEMO.xiaoyi));
      expect(await getCurrentUser()).toBeNull();
      await db().update(users).set({ state: "active" }).where(eq(users.id, DEMO.xiaoyi));
    });

    it("全站封禁生效 → 会话失效；封禁到期或仅版块级禁言 → 仍有效", async () => {
      await createSession(DEMO.banned); // 夹具里该用户有永久全站封禁
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

    it("滑动续期：超过 1 小时未活动才更新 last_seen_at（避免写放大）", async () => {
      await createSession(DEMO.admin);
      const id = hashToken(jar.get(SESSION_COOKIE)!.value);
      const seen = async () =>
        (await db().select().from(sessions).where(eq(sessions.id, id)))[0]!.lastSeenAt;

      const fresh = await seen();
      await getCurrentUser();
      expect(await seen()).toBe(fresh); // 刚创建：不续期

      await db().execute(
        sql`UPDATE sessions SET last_seen_at = NOW() - INTERVAL 2 HOUR WHERE id = ${id}`,
      );
      const stale = await seen();
      await getCurrentUser();
      expect(await seen()).not.toBe(stale);
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
    it("destroyCurrentSession：删库中会话行并清 cookie；无 cookie 时安全空操作", async () => {
      await destroyCurrentSession(); // 无 cookie：不抛
      await createSession(DEMO.alice);
      const id = hashToken(jar.get(SESSION_COOKIE)!.value);
      await destroyCurrentSession();
      expect(jar.has(SESSION_COOKIE)).toBe(false);
      expect(await db().select().from(sessions).where(eq(sessions.id, id))).toHaveLength(0);
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
  });
});
