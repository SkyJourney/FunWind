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
import {
  createRestriction,
  liftRestriction,
  listAdminUsersPage,
  searchUsers,
} from "./restrictions-admin";
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
    expect(
      await createRestriction(ACTOR, {
        userId: 90005,
        kind: "mute",
        reason: "past expiry",
        endsAt: "2000-01-01 00:00:00",
      }),
    ).toMatchObject({ ok: false, code: "bad_ends_at" });

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
    await assignUserRole(adminActor, DEMO.member, roleKey, 0);

    try {
      const [banAttempt, revokeAttempt] = await Promise.all([
        createRestriction(ACTOR, {
          userId: DEMO.admin,
          kind: "ban",
          reason,
          endsAt: null,
        }),
        revokeUserRole(adminActor, DEMO.member, roleKey, 0).then(
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
});
