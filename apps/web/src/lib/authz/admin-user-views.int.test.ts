// @vitest-environment node
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  DEMO,
  getWebDb,
  sessions,
  userRestrictions,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { generateToken, hashToken } from "@/lib/auth/token";
import { adminUserDetail, listAdminUsersPage, searchUsers } from "./admin-user-views";
import * as legacyViews from "./restrictions-admin";

let tdb: TempDb;
const db = () => getWebDb();

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("后台用户查询视图 · 真实 MySQL", () => {
  it("旧限制管理出口继续转发原查询接口", () => {
    expect(legacyViews.adminUserDetail).toBe(adminUserDetail);
    expect(legacyViews.listAdminUsersPage).toBe(listAdminUsersPage);
    expect(legacyViews.searchUsers).toBe(searchUsers);
  });

  it("后台详情只有显式 user.viewIp 授权结果才带会话 IP", async () => {
    const sessionId = hashToken(generateToken());
    const ip = "203.0.113.77";
    await db()
      .insert(sessions)
      .values({
        id: sessionId,
        userId: DEMO.team,
        createdAt: sql`NOW()`,
        expiresAt: sql`NOW() + INTERVAL 1 DAY`,
        lastSeenAt: sql`NOW()`,
        ip,
        userAgent: "step5-ip-projection",
      });
    try {
      const hidden = await adminUserDetail(DEMO.team, false);
      const visible = await adminUserDetail(DEMO.team, true);
      expect(hidden?.sessions.some((session) => session.ip === ip)).toBe(false);
      expect(visible?.sessions.some((session) => session.ip === ip)).toBe(true);
    } finally {
      await db().delete(sessions).where(eq(sessions.id, sessionId));
    }
  });

  it("searchUsers：包含匹配、只 active、空串空结果", async () => {
    const rows = await searchUsers("demo_");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.username.includes("demo_"))).toBe(true);
    expect(await searchUsers("")).toEqual([]);
  });

  it("listAdminUsersPage：默认最新注册、uid 等值、受限筛选与总数（M9.5）", async () => {
    // 给 member（90005）上一个长期生效的限制，验证 restricted 筛选
    await db().insert(userRestrictions).values({
      userId: 90005,
      kind: "mute",
      scopeId: 0,
      reason: "列表筛选测试",
      startsAt: "2026-01-01 00:00:00",
      endsAt: "2099-01-01 00:00:00",
      createdAt: "2026-01-01 00:00:00",
    });

    const def = await listAdminUsersPage({ status: "all", sort: "recent" }, 1);
    expect(def.total).toBeGreaterThan(0);
    expect(def.items.length).toBeLessThanOrEqual(20);
    // 最新注册在前（seed 里 team 90006 注册最晚）
    expect(def.items[0]?.id).toBe(90006);

    // uid 等值直达
    const byUid = await listAdminUsersPage({ q: "90005", status: "all", sort: "recent" }, 1);
    expect(byUid.total).toBe(1);
    expect(byUid.items[0]?.id).toBe(90005);

    // 受限筛选必含 banned（90003，种子自带永久封禁，任何前序用例不动它），且标记为真
    const restricted = await listAdminUsersPage({ status: "restricted", sort: "recent" }, 1);
    expect(restricted.total).toBeGreaterThanOrEqual(1);
    const hit = restricted.items.find((r) => r.id === 90003);
    expect(hit?.restricted).toBe(true);
    // 全量列表里 banned 同样带受限标记；正常用户（90001）不带
    const all = await listAdminUsersPage({ status: "all", sort: "id" }, 1);
    expect(all.items.find((r) => r.id === 90003)?.restricted).toBe(true);
    expect(all.items.find((r) => r.id === 90001)?.restricted).toBe(false);

    // 主题数排序：全 0 时按 uid 倒序兜底，不报错即可
    const byThreads = await listAdminUsersPage({ status: "all", sort: "threads" }, 1);
    expect(byThreads.items.length).toBeGreaterThan(0);
  });

  it("生命周期与凭据筛选展示注销申请、待验证、待认领和匿名删除账号", async () => {
    const deletedId = 99999234;
    const noPasswordId = 99999235;
    const completedTombstoneId = 99999236;
    const [previous] = await db()
      .select({
        emailVerificationRequired: users.emailVerificationRequired,
        legacyPasswordPending: users.legacyPasswordPending,
      })
      .from(users)
      .where(eq(users.id, DEMO.team));
    await db()
      .update(users)
      .set({ emailVerificationRequired: true, legacyPasswordPending: true })
      .where(eq(users.id, DEMO.team));
    const [closure] = (await db()
      .insert(accountDeletionRequests)
      .values({
        userId: DEMO.team,
        status: "pending",
        requestedAt: sql`NOW()`,
        scheduledAt: sql`NOW() + INTERVAL 30 DAY`,
      })) as unknown as [{ insertId: number }];
    await db()
      .insert(users)
      .values({
        id: deletedId,
        username: `已注销用户#${deletedId}`,
        usernameKey: `deleted-${deletedId}`,
        email: null,
        emailKey: null,
        passwordHash: null,
        state: "deleted",
        createdAt: "2026-01-01 00:00:00",
      });
    await db().insert(users).values({
      id: noPasswordId,
      username: "governance_claim_pending",
      usernameKey: "governance_claim_pending",
      email: null,
      emailKey: null,
      passwordHash: null,
      state: "active",
      createdAt: "2026-01-01 00:00:00",
    });
    await db().insert(users).values({
      id: completedTombstoneId,
      username: "old-private-name",
      usernameKey: "old_private_name",
      email: "completed@example.com",
      emailKey: "completed@example.com",
      passwordHash: "test-hash",
      emailVerificationRequired: true,
      state: "active",
      createdAt: "2026-01-01 00:00:00",
    });
    await db()
      .insert(accountDeletionRequests)
      .values({
        userId: completedTombstoneId,
        status: "completed",
        requestedAt: sql`NOW()`,
        scheduledAt: sql`NOW()`,
        completedAt: sql`NOW()`,
      });

    try {
      const [storedClosure] = await db()
        .select()
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.userId, DEMO.team))
        .orderBy(desc(accountDeletionRequests.id))
        .limit(1);
      expect(storedClosure?.status).toBe("pending");
      expect(await adminUserDetail(DEMO.team, false)).toMatchObject({
        state: "active",
        emailVerificationRequired: true,
        legacyPasswordPending: true,
        closureRequest: { status: "pending" },
      });
      const closurePage = await listAdminUsersPage({ lifecycle: "closure_pending", sort: "id" }, 1);
      expect(closurePage.items.find((row) => row.id === DEMO.team)).toMatchObject({
        closurePending: true,
        emailVerificationRequired: true,
        legacyPasswordPending: true,
      });
      expect(
        closurePage.items.find((row) => row.id === DEMO.team)?.closureScheduledAt,
      ).toBeTruthy();

      const deletedPage = await listAdminUsersPage({ lifecycle: "deleted", sort: "id" }, 1);
      expect(deletedPage.items.find((row) => row.id === deletedId)?.username).toBe("已注销用户");
      expect(await adminUserDetail(completedTombstoneId, false)).toMatchObject({
        username: "已注销用户",
        state: "deleted",
        email: null,
        emailVerificationRequired: false,
        hasPassword: false,
      });
      expect(deletedPage.items.find((row) => row.id === completedTombstoneId)).toMatchObject({
        username: "已注销用户",
        state: "deleted",
        emailVerified: false,
        emailVerificationRequired: false,
        hasPassword: false,
        legacyPasswordPending: false,
        restricted: false,
      });

      const unverifiedPage = await listAdminUsersPage(
        {
          lifecycle: "all",
          credential: "email_unverified",
          sort: "id",
        },
        1,
      );
      expect(unverifiedPage.items.some((row) => row.id === DEMO.team)).toBe(true);
      const noPasswordPage = await listAdminUsersPage(
        {
          lifecycle: "all",
          credential: "no_password",
          sort: "id",
        },
        1,
      );
      expect(noPasswordPage.items.some((row) => row.id === noPasswordId)).toBe(true);
      const legacyPage = await listAdminUsersPage(
        {
          lifecycle: "all",
          credential: "legacy_password_pending",
          sort: "id",
        },
        1,
      );
      expect(legacyPage.items.some((row) => row.id === DEMO.team)).toBe(true);
    } finally {
      await db()
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, Number(closure.insertId)));
      await db()
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.userId, completedTombstoneId));
      await db()
        .update(users)
        .set({
          emailVerificationRequired: previous?.emailVerificationRequired ?? false,
          legacyPasswordPending: previous?.legacyPasswordPending ?? false,
        })
        .where(eq(users.id, DEMO.team));
      await db()
        .delete(users)
        .where(inArray(users.id, [deletedId, noPasswordId, completedTombstoneId]));
    }
  });
});
