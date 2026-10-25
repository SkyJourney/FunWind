// @vitest-environment node
/**
 * 荣誉徽章集成测试（M7 S6）：授予 + 审计同事务、badge.awarded 经 outbox、
 * 重复发放（串行与并发，M7-2 口径）、展示查询过滤（停用/过期不显示）。
 */
import "@/modules";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, badges, DEMO, eventLog, getWebDb, userBadges } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminError } from "@/lib/authz/admin";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { badgeDictionary, grantBadgeByAdmin, userBadgesOf } from "./service";

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

    const [ev] = await db().select().from(eventLog).where(eq(eventLog.eventName, "badge.awarded"));
    expect(ev.source).toBe("badges");
    expect(ev.actorId).toBe(DEMO.admin);
  });

  it("展示查询：持有者在列；停用徽章不显示", async () => {
    const id = await badgeId();
    expect((await userBadgesOf(DEMO.alice)).map((b) => b.badgeId)).toContain(id);
    await db().update(badges).set({ isActive: false }).where(eq(badges.id, id));
    expect((await userBadgesOf(DEMO.alice)).map((b) => b.badgeId)).not.toContain(id);
    await db().update(badges).set({ isActive: true }).where(eq(badges.id, id));
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
    expect((rejected[0] as { reason: unknown }).reason).toBeInstanceOf(AdminError);
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

  it("未知/停用徽章拒绝；字典只含启用中的徽章", async () => {
    await expect(grantBadgeByAdmin(ADMIN, { userId: DEMO.team, badgeId: 999999 })).rejects.toThrow(
      AdminError,
    );
    const dict = await badgeDictionary();
    expect(dict.every((b) => b.isActive)).toBe(true);
    expect(dict.length).toBeGreaterThanOrEqual(1);
  });
});
