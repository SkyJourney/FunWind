// @vitest-environment node
/**
 * 限制管理集成测试（M9 S5）：创建/幂等冲突/解除、审计、事件经 outbox、当事人通知（经真实消费者）。
 */
import "@/modules";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditLog,
  DEMO,
  eventOutbox,
  getWebDb,
  notifications,
  sessions,
  userRestrictions,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { generateToken, hashToken } from "@/lib/auth/token";
import { createRestriction, liftRestriction, revokeUserSessionByAdmin } from "./restrictions-admin";
import {
  assignUserRole,
  createCustomRole,
  deleteCustomRole,
  grantRolePermission,
  revokeUserRole,
} from "./admin";

let tdb: TempDb;
const db = () => getWebDb();
const ACTOR = { userId: 90004, via: "admin" as const, ip: "127.0.0.1" };

async function activeRestrictions(
  userId: number,
  kind: "ban" | "forum_ban" | "mute" | "no_avatar" | "no_signature",
) {
  return db()
    .select()
    .from(userRestrictions)
    .where(and(eq(userRestrictions.userId, userId), eq(userRestrictions.kind, kind)));
}

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("限制管理（M9）", () => {
  it("创建禁言：落行+审计+事件经 outbox+当事人通知（account.restricted 强制）", async () => {
    const r = await createRestriction(ACTOR, {
      userId: 90005,
      kind: "mute",
      reason: "测试禁言",
      endsAt: "2099-01-01 00:00:00",
    });
    expect(r).toEqual({ ok: true });
    const rows = await activeRestrictions(90005, "mute");
    expect(rows).toHaveLength(1);
    expect(rows[0].createdBy).toBe(90004);

    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "restriction.create"), eq(auditLog.targetId, "90005")))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(audit).toBeDefined();

    const [ev] = await db()
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.eventName, "restriction.changed"));
    expect(ev.dispatchedAt).not.toBeNull();

    const [notif] = await db()
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, 90005), eq(notifications.type, "account.restricted")));
    expect(notif).toBeDefined();
    expect((notif.data as { reason: string }).reason).toBe("测试禁言");

    // 幂等：同 kind 再建 → already
    expect(
      await createRestriction(ACTOR, { userId: 90005, kind: "mute", reason: "再来", endsAt: null }),
    ).toEqual({ ok: false, code: "already" });
  });

  it("解除：endsAt 提前到当前、审计、lifted 通知；过期行再解除 → already", async () => {
    const [row] = (await activeRestrictions(90005, "mute"))[0]
      ? await activeRestrictions(90005, "mute")
      : [];
    expect(row).toBeDefined();
    const r = await liftRestriction(ACTOR, row!.id, "测试解除");
    expect(r).toEqual({ ok: true });
    const after = await activeRestrictions(90005, "mute");
    expect(after[0].endsAt).not.toBeNull();

    const [liftNotif] = await db()
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, 90005), eq(notifications.type, "account.restriction_lifted")),
      );
    expect(liftNotif).toBeDefined();

    // 已提前结束的再解除 → already
    expect(await liftRestriction(ACTOR, row!.id, "重复解除")).toEqual({
      ok: false,
      code: "already",
    });
  });

  it("非法 kind / 空理由 / 不存在用户", async () => {
    expect(
      await createRestriction(ACTOR, { userId: 90005, kind: "explode", reason: "x", endsAt: null }),
    ).toEqual({
      ok: false,
      code: "bad_kind",
    });
    expect(
      await createRestriction(ACTOR, { userId: 90005, kind: "ban", reason: "  ", endsAt: null }),
    ).toEqual({
      ok: false,
      code: "reason_required",
    });
    expect(
      await createRestriction(ACTOR, { userId: 99999999, kind: "ban", reason: "x", endsAt: null }),
    ).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("限制类型与 scope 矩阵、时间边界和目标状态由服务端校验", async () => {
    expect(
      await createRestriction(ACTOR, {
        userId: 90005,
        kind: "ban",
        scopeId: DEMO.restrictedForum,
        reason: "scope mismatch",
        endsAt: null,
      }),
    ).toMatchObject({ ok: false, code: "bad_scope" });
    expect(
      await createRestriction(ACTOR, {
        userId: 90005,
        kind: "forum_ban",
        reason: "scope required",
        endsAt: null,
      }),
    ).toMatchObject({ ok: false, code: "bad_scope" });
    expect(
      await createRestriction(ACTOR, {
        userId: 90005,
        kind: "no_avatar",
        scopeId: DEMO.restrictedForum,
        reason: "global only",
        endsAt: null,
      }),
    ).toMatchObject({ ok: false, code: "bad_scope" });
    expect(
      await createRestriction(ACTOR, {
        userId: 90005,
        kind: "forum_ban",
        scopeId: 99999999,
        reason: "unknown forum",
        endsAt: null,
      }),
    ).toMatchObject({ ok: false, code: "bad_scope" });
    for (const endsAt of [
      "2000-01-01 00:00:00",
      "2099-02-29 00:00:00",
      "2096-02-30 00:00:00",
      "2099-01-01T00:00:00",
    ]) {
      expect(
        await createRestriction(ACTOR, {
          userId: 90005,
          kind: "mute",
          reason: "过期或非法时间测试",
          endsAt,
        }),
      ).toMatchObject({ ok: false, code: "bad_ends_at" });
    }

    await db().update(users).set({ state: "deleted" }).where(eq(users.id, 90005));
    expect(
      await createRestriction(ACTOR, {
        userId: 90005,
        kind: "mute",
        reason: "closed account",
        endsAt: null,
      }),
    ).toMatchObject({ ok: false, code: "bad_state" });
    await db().update(users).set({ state: "active" }).where(eq(users.id, 90005));

    expect(
      await createRestriction(ACTOR, {
        userId: 90005,
        kind: "forum_ban",
        scopeId: DEMO.restrictedForum,
        reason: "subtree block",
        endsAt: null,
      }),
    ).toEqual({ ok: true });
    const forumBan = await activeRestrictions(90005, "forum_ban");
    expect(forumBan).toHaveLength(1);
    expect(forumBan[0]?.scopeId).toBe(DEMO.restrictedForum);
    expect(await liftRestriction(ACTOR, forumBan[0]!.id, "解除板块禁入")).toEqual({ ok: true });
  });

  it("全站 ban 原子吊销所有设备 session；解封后旧 session 不恢复", async () => {
    const token = generateToken();
    const sessionId = hashToken(token);
    await db()
      .insert(sessions)
      .values({
        id: sessionId,
        userId: DEMO.team,
        createdAt: sql`NOW()`,
        expiresAt: sql`NOW() + INTERVAL 1 DAY`,
        lastSeenAt: sql`NOW()`,
        ip: null,
        userAgent: null,
      });
    expect(await db().select().from(sessions).where(eq(sessions.userId, DEMO.team))).toHaveLength(
      1,
    );

    expect(
      await createRestriction(ACTOR, {
        userId: DEMO.team,
        kind: "ban",
        reason: "session revocation",
        endsAt: null,
      }),
    ).toEqual({ ok: true });
    expect(await db().select().from(sessions).where(eq(sessions.userId, DEMO.team))).toHaveLength(
      0,
    );

    const [ban] = await activeRestrictions(DEMO.team, "ban");
    expect(await liftRestriction(ACTOR, ban!.id, "解除封禁")).toEqual({ ok: true });
    expect(await db().select().from(sessions).where(eq(sessions.id, sessionId))).toHaveLength(0);
  });

  it("不能封禁最后一位有效站点管理员", async () => {
    expect(
      await createRestriction(ACTOR, {
        userId: DEMO.admin,
        kind: "ban",
        reason: "last admin guard",
        endsAt: null,
      }),
    ).toEqual({ ok: false, code: "last_admin" });
    expect(await activeRestrictions(DEMO.admin, "ban")).toHaveLength(0);
  });

  it("全站 ban 与撤销另一管理员绑定并发时仍共享末位管理员互斥锁", async () => {
    const roleKey = "m96-ban-race-admin";
    const reason = "m9.6-last-admin-race";
    const adminActor = { userId: DEMO.admin, ip: ACTOR.ip };
    await createCustomRole(adminActor, roleKey, "并发管理员", "");
    await grantRolePermission(adminActor, roleKey, "site.admin", 0);
    await grantRolePermission(adminActor, roleKey, "admin.roles", 0);
    await assignUserRole(adminActor, DEMO.member, roleKey, 0, null, "跨服务并发测试");

    try {
      const [banAttempt, revokeAttempt] = await Promise.all([
        createRestriction(ACTOR, {
          userId: DEMO.admin,
          kind: "ban",
          reason,
          endsAt: null,
        }),
        revokeUserRole(adminActor, DEMO.member, roleKey, 0, "跨服务并发测试").then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);
      expect(Number(banAttempt.ok) + Number(revokeAttempt.ok)).toBe(1);
      if (!banAttempt.ok) expect(banAttempt.code).toBe("last_admin");
      if (!revokeAttempt.ok) expect(revokeAttempt.error).toMatchObject({ name: "AdminError" });
    } finally {
      const [ban] = (await activeRestrictions(DEMO.admin, "ban")).filter(
        (row) => row.reason === reason,
      );
      if (ban) await liftRestriction(ACTOR, ban.id, "并发测试清理");
      await deleteCustomRole(adminActor, roleKey);
    }
  });

  it("后台会话撤销按用户归属校验", async () => {
    const sessionId = hashToken(generateToken());
    await db()
      .insert(sessions)
      .values({
        id: sessionId,
        userId: DEMO.team,
        createdAt: sql`NOW()`,
        expiresAt: sql`NOW() + INTERVAL 1 DAY`,
      });
    try {
      expect(await revokeUserSessionByAdmin(ACTOR, DEMO.member, sessionId)).toEqual({
        ok: false,
        code: "session_not_found",
      });
      expect(await db().select().from(sessions).where(eq(sessions.id, sessionId))).toHaveLength(1);
      expect(await revokeUserSessionByAdmin(ACTOR, DEMO.team, sessionId)).toEqual({ ok: true });
      expect(await db().select().from(sessions).where(eq(sessions.id, sessionId))).toHaveLength(0);
    } finally {
      await db().delete(sessions).where(eq(sessions.id, sessionId));
    }
  });
});
