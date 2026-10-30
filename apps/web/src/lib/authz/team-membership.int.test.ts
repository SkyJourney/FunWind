// @vitest-environment node
import "@/modules";
import { and, eq } from "drizzle-orm";
import {
  DEMO,
  auditLog,
  badges,
  eventOutbox,
  getWebDb,
  notifications,
  roleGrants,
  roles,
  userBadges,
  userRoles,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { AdminError, assignUserRole, revokeUserRole } from "./admin";
import { assignTeamMembership, revokeTeamMembership } from "./team-membership";
import { grantBadgeByAdmin, userBadgesOf } from "@/lib/badges/service";

const ROLE_KEY = "team-subtitle";
const BADGE_KEY = "team-subtitle";
const EXPIRY = "2099-01-01 00:00:00";
const RENEWED_EXPIRY = "2099-06-01 00:00:00";
const ACTOR = { userId: DEMO.admin, via: "admin" as const, ip: "203.0.113.7" };

let tdb: TempDb;
let badgeId: number;
const db = () => getWebDb();

beforeAll(async () => {
  tdb = await setupTempDb();
  await db()
    .insert(roles)
    .values({ key: ROLE_KEY, name: "字幕制作组", kind: "custom", description: "", isPublic: false })
    .onDuplicateKeyUpdate({ set: { name: "字幕制作组", isPublic: false } });
  await db()
    .insert(badges)
    .values({ key: BADGE_KEY, name: "字幕制作组", kind: "team", isActive: true })
    .onDuplicateKeyUpdate({ set: { name: "字幕制作组", kind: "team", isActive: true } });
  const [badge] = await db()
    .select({ id: badges.id })
    .from(badges)
    .where(eq(badges.key, BADGE_KEY));
  badgeId = badge!.id;
  await db()
    .delete(userRoles)
    .where(and(eq(userRoles.userId, DEMO.member), eq(userRoles.roleKey, ROLE_KEY)));
  await db()
    .delete(userBadges)
    .where(and(eq(userBadges.userId, DEMO.member), eq(userBadges.badgeId, badgeId)));
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("团队成员服务 · 真实 MySQL", () => {
  it("授予与续期在同一规则下同步 role/badge，到期时间一致且通知经 outbox", async () => {
    await assignTeamMembership(ACTOR, {
      userId: DEMO.member,
      roleKey: ROLE_KEY,
      expiresAt: EXPIRY,
    });
    let [role] = await db()
      .select({ scopeId: userRoles.scopeId, expiresAt: userRoles.expiresAt })
      .from(userRoles)
      .where(and(eq(userRoles.userId, DEMO.member), eq(userRoles.roleKey, ROLE_KEY)));
    let [badge] = await db()
      .select({ expiresAt: userBadges.expiresAt })
      .from(userBadges)
      .where(and(eq(userBadges.userId, DEMO.member), eq(userBadges.badgeId, badgeId)));
    expect(role).toEqual({ scopeId: 0, expiresAt: EXPIRY });
    expect(badge?.expiresAt).toBe(EXPIRY);
    expect((await userBadgesOf(DEMO.member)).map((item) => item.key)).toContain(BADGE_KEY);

    await assignTeamMembership(ACTOR, {
      userId: DEMO.member,
      roleKey: ROLE_KEY,
      expiresAt: RENEWED_EXPIRY,
    });
    [role] = await db()
      .select({ scopeId: userRoles.scopeId, expiresAt: userRoles.expiresAt })
      .from(userRoles)
      .where(and(eq(userRoles.userId, DEMO.member), eq(userRoles.roleKey, ROLE_KEY)));
    [badge] = await db()
      .select({ expiresAt: userBadges.expiresAt })
      .from(userBadges)
      .where(and(eq(userBadges.userId, DEMO.member), eq(userBadges.badgeId, badgeId)));
    expect(role?.expiresAt).toBe(RENEWED_EXPIRY);
    expect(badge?.expiresAt).toBe(RENEWED_EXPIRY);

    const roleEvents = await db()
      .select({ payload: eventOutbox.payload, dispatchedAt: eventOutbox.dispatchedAt })
      .from(eventOutbox)
      .where(and(eq(eventOutbox.eventName, "role.changed"), eq(eventOutbox.actorId, DEMO.admin)));
    expect(
      roleEvents.filter((event) => (event.payload as { userId?: number }).userId === DEMO.member),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ roleKey: ROLE_KEY, expiresAt: EXPIRY }),
          dispatchedAt: expect.any(String),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({ roleKey: ROLE_KEY, expiresAt: RENEWED_EXPIRY }),
          dispatchedAt: expect.any(String),
        }),
      ]),
    );
    const [roleNotice] = await db()
      .select({ data: notifications.data })
      .from(notifications)
      .where(
        and(eq(notifications.userId, DEMO.member), eq(notifications.type, "account.role_changed")),
      )
      .orderBy(notifications.id);
    expect(roleNotice?.data).toMatchObject({ scopeLabel: "全站", validity: `有效至 ${EXPIRY}` });
    const [badgeNotice] = await db()
      .select({ data: notifications.data })
      .from(notifications)
      .where(and(eq(notifications.userId, DEMO.member), eq(notifications.type, "badge.awarded")));
    expect(badgeNotice?.data).toMatchObject({ badgeId });
  });

  it("团队成员校验期限，并阻止普通授撤入口绕过成员服务", async () => {
    await expect(
      assignTeamMembership(ACTOR, {
        userId: DEMO.team,
        roleKey: ROLE_KEY,
        expiresAt: "2000-01-01 00:00:00",
      }),
    ).rejects.toThrow(/未来北京时间/);
    await expect(assignUserRole(ACTOR, DEMO.team, ROLE_KEY, 0)).rejects.toThrow(/团队成员服务/);
    await expect(revokeUserRole(ACTOR, DEMO.team, ROLE_KEY, 0)).rejects.toThrow(/团队成员服务/);
    await expect(grantBadgeByAdmin(ACTOR, { userId: DEMO.team, badgeId })).rejects.toThrow(
      /团队成员服务/,
    );
  });

  it("撤销同时移除两种身份并通知；重复撤销不产生新事件", async () => {
    await revokeTeamMembership(ACTOR, DEMO.member, ROLE_KEY);
    expect(
      await db()
        .select()
        .from(userRoles)
        .where(and(eq(userRoles.userId, DEMO.member), eq(userRoles.roleKey, ROLE_KEY))),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(userBadges)
        .where(and(eq(userBadges.userId, DEMO.member), eq(userBadges.badgeId, badgeId))),
    ).toHaveLength(0);
    const before = await db()
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(and(eq(eventOutbox.eventName, "role.changed"), eq(eventOutbox.actorId, DEMO.admin)));
    await revokeTeamMembership(ACTOR, DEMO.member, ROLE_KEY);
    const after = await db()
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(and(eq(eventOutbox.eventName, "role.changed"), eq(eventOutbox.actorId, DEMO.admin)));
    expect(after).toHaveLength(before.length);
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "team_membership.revoke"),
          eq(auditLog.targetId, String(DEMO.member)),
        ),
      );
    expect(audit).toBeDefined();
    const [badgeNotice] = await db()
      .select({ data: notifications.data })
      .from(notifications)
      .where(and(eq(notifications.userId, DEMO.member), eq(notifications.type, "badge.revoked")));
    expect(badgeNotice?.data).toMatchObject({ badgeId });
  });

  it("通过团队服务撤销全站管理能力也受末位管理员保护", async () => {
    const userId = 99999001;
    await db().insert(users).values({
      id: userId,
      username: "team_admin_fixture",
      usernameKey: "team_admin_fixture",
      email: "team-admin@example.com",
      emailKey: "team-admin@example.com",
      passwordHash: "test-hash",
      state: "active",
      createdAt: "2026-10-29 00:00:00",
    });
    await db()
      .insert(roleGrants)
      .values([
        { roleKey: ROLE_KEY, permissionKey: "site.admin", scopeId: 0 },
        { roleKey: ROLE_KEY, permissionKey: "admin.roles", scopeId: 0 },
      ]);
    await assignTeamMembership(ACTOR, { userId, roleKey: ROLE_KEY, expiresAt: null });

    try {
      await revokeUserRole(ACTOR, DEMO.admin, "admin", 0);
      await expect(revokeTeamMembership(ACTOR, userId, ROLE_KEY)).rejects.toBeInstanceOf(
        AdminError,
      );
      expect(
        await db()
          .select()
          .from(userRoles)
          .where(and(eq(userRoles.userId, userId), eq(userRoles.roleKey, ROLE_KEY))),
      ).toHaveLength(1);
      expect(
        await db()
          .select()
          .from(userBadges)
          .where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badgeId))),
      ).toHaveLength(1);
    } finally {
      await assignUserRole(ACTOR, DEMO.admin, "admin", 0);
      await revokeTeamMembership(ACTOR, userId, ROLE_KEY);
      await db().delete(roleGrants).where(eq(roleGrants.roleKey, ROLE_KEY));
      await db().delete(users).where(eq(users.id, userId));
    }
  });
});
