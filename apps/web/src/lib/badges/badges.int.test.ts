// @vitest-environment node
/**
 * 荣誉徽章集成测试（M7 S6）：授予 + 审计同事务、badge.awarded 经 outbox、
 * 重复发放（串行与并发，M7-2 口径）、展示查询过滤（停用/过期不显示）。
 */
import "@/modules";
import { and, eq, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  auditLog,
  badges,
  DEMO,
  eventLog,
  getWebDb,
  userBadges,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminError } from "@/lib/authz/admin";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { badgeDictionary, grantBadgeByAdmin, recentBadgeGrants, userBadgesOf } from "./service";

let tdb: TempDb;
const db = () => getWebDb();
const ADMIN = { userId: DEMO.admin, via: "admin" as const, ip: "127.0.0.1" };

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

/** 测试专用徽章（不用种子的 demo-pioneer——它已按夹具发给 alice） */
async function badgeId(): Promise<number> {
  const [b] = await db()
    .select({ id: badges.id })
    .from(badges)
    .where(eq(badges.key, "test-grant-badge"));
  if (b) return b.id;
  const [created] = (await db().insert(badges).values({
    key: "test-grant-badge",
    name: "测试徽章",
    description: "集成测试",
    kind: "honor",
  })) as unknown as [{ insertId: number }];
  return Number(created.insertId);
}

describe.skipIf(skipDb)("徽章授予（M7）", () => {
  it("授予：user_badges 落行、审计落行、badge.awarded 经 outbox 派发（event_log source=badges）", async () => {
    const id = await badgeId();
    await grantBadgeByAdmin(ADMIN, { userId: DEMO.alice, badgeId: id });

    const [row] = await db()
      .select()
      .from(userBadges)
      .where(and(eq(userBadges.userId, DEMO.alice), eq(userBadges.badgeId, id)));
    expect(row.awardedBy).toBe(DEMO.admin);

    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "badge.grant"))
      .orderBy(sql`id DESC`)
      .limit(1);
    expect(audit.targetId).toBe(String(DEMO.alice));

    const [ev] = await db()
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.eventName, "badge.awarded"), eq(eventLog.source, "badges")))
      .orderBy(sql`id DESC`)
      .limit(1);
    expect(ev, "badge.awarded 的首派 event_log 行").toBeDefined();
    expect(ev.actorId).toBe(DEMO.admin);
  });

  it("展示查询：持有者在列；停用徽章与已过期徽章不显示", async () => {
    const id = await badgeId();
    expect((await userBadgesOf(DEMO.alice)).map((b) => b.badgeId)).toContain(id);

    // 停用不显示
    await db().update(badges).set({ isActive: false }).where(eq(badges.id, id));
    expect((await userBadgesOf(DEMO.alice)).map((b) => b.badgeId)).not.toContain(id);
    await db().update(badges).set({ isActive: true }).where(eq(badges.id, id));

    // 过期不显示（expiresAt 只能由迁移/导入数据写入——授予恒为 null，该分支的数据形态在此钉住）
    await db()
      .insert(userBadges)
      .values({
        userId: DEMO.xiaoyi,
        badgeId: id,
        awardedAt: "2026-01-01 00:00:00",
        expiresAt: "2026-01-02 00:00:00",
      })
      .onDuplicateKeyUpdate({ set: { expiresAt: "2026-01-02 00:00:00" } });
    expect((await userBadgesOf(DEMO.xiaoyi)).map((b) => b.badgeId)).not.toContain(id);
    await db()
      .update(userBadges)
      .set({ expiresAt: "2099-01-01 00:00:00" })
      .where(and(eq(userBadges.userId, DEMO.xiaoyi), eq(userBadges.badgeId, id)));
    expect((await userBadgesOf(DEMO.xiaoyi)).map((b) => b.badgeId)).toContain(id);

    // 自清理：本用例给 xiaoyi 造的持有行不留给后续用例（并发授予用例以同一徽章为夹具）
    await db().delete(userBadges).where(eq(userBadges.userId, DEMO.xiaoyi));
  });

  it("重复授予（串行）：AdminError 已持有", async () => {
    const id = await badgeId();
    await expect(grantBadgeByAdmin(ADMIN, { userId: DEMO.alice, badgeId: id })).rejects.toThrow(
      AdminError,
    );
  });

  it("并发重复发放（M7-2）：两路并发恰 1 路成功，另一路回滚为已持有", async () => {
    const id = await badgeId();
    const victim = DEMO.xiaoyi;
    const results = await Promise.allSettled([
      grantBadgeByAdmin(ADMIN, { userId: victim, badgeId: id }),
      grantBadgeByAdmin(ADMIN, { userId: victim, badgeId: id }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    const reasons = rejected.map((r) => (r as { reason: unknown }).reason);
    expect(reasons[0]).toBeInstanceOf(AdminError);
    const rows = await db()
      .select()
      .from(userBadges)
      .where(and(eq(userBadges.userId, victim), eq(userBadges.badgeId, id)));
    expect(rows).toHaveLength(1);
    // 失败一侧审计不落行（同事务回滚）
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "badge.grant"), eq(auditLog.targetId, String(victim))));
    expect(audits).toHaveLength(1);
  });

  it("后台徽章授予历史将已注销用户姓名与 UID 匿名化", async () => {
    const [created] = (await db().insert(badges).values({
      key: "test-anonymous-history-badge",
      name: "注销匿名历史",
      description: "集成测试",
      kind: "honor",
    })) as unknown as [{ insertId: number }];
    const id = Number(created.insertId);
    await db()
      .insert(userBadges)
      .values({ userId: DEMO.alice, badgeId: id, awardedAt: sql`NOW()` });
    await db()
      .insert(accountDeletionRequests)
      .values({
        userId: DEMO.alice,
        status: "completed",
        requestedAt: sql`NOW()`,
        scheduledAt: sql`NOW()`,
        completedAt: sql`NOW()`,
      });
    try {
      const grant = (await recentBadgeGrants(100)).find((row) => row.badgeName === "注销匿名历史");
      expect(grant).toMatchObject({ userId: null, username: "已注销用户" });
    } finally {
      await db()
        .delete(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.userId, DEMO.alice),
            eq(accountDeletionRequests.status, "completed"),
          ),
        );
      await db().delete(userBadges).where(eq(userBadges.badgeId, id));
      await db().delete(badges).where(eq(badges.id, id));
    }
  });

  it("注销申请中的账号不能收到新徽章", async () => {
    const id = await badgeId();
    const [closure] = (await db()
      .insert(accountDeletionRequests)
      .values({
        userId: DEMO.team,
        status: "pending",
        requestedAt: sql`NOW()`,
        scheduledAt: sql`NOW() + INTERVAL 30 DAY`,
      })) as unknown as [{ insertId: number }];
    try {
      await expect(grantBadgeByAdmin(ADMIN, { userId: DEMO.team, badgeId: id })).rejects.toThrow(
        /注销中或已注销/,
      );
      expect(
        await db()
          .select()
          .from(userBadges)
          .where(and(eq(userBadges.userId, DEMO.team), eq(userBadges.badgeId, id))),
      ).toHaveLength(0);
    } finally {
      await db()
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, Number(closure.insertId)));
    }
  });

  it("未知/停用徽章拒绝；字典只含启用中的徽章", async () => {
    await expect(grantBadgeByAdmin(ADMIN, { userId: DEMO.team, badgeId: 999999 })).rejects.toThrow(
      AdminError,
    );
    const dict = await badgeDictionary();
    expect(dict.every((b) => b.isActive)).toBe(true);
    expect(dict.length).toBeGreaterThanOrEqual(1);
  });
});
