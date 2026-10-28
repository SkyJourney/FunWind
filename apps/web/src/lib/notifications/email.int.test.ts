// @vitest-environment node
/**
 * 通知邮件渠道判定集成测试（M10.6 收尾切片）：安全开关默认/落库、用户级偏好默认关、
 * 私信邮件频控、活跃判定（会话 last_seen_at）。
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWebDb } from "@funwind/db";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  pmEmailAllowed,
  securityEmailEnabled,
  userActiveRecently,
  userEmailEnabled,
} from "./email";

let tdb: TempDb;

beforeAll(async () => {
  tdb = await setupTempDb({ demo: true });
});

afterAll(() => {
  tdb?.teardown();
});

describe.skipIf(skipDb)("通知邮件渠道（M10.6 收尾切片）", () => {
  it("securityEmailEnabled：无配置默认开；落库 false 后关", async () => {
    expect(await securityEmailEnabled()).toBe(true); // 默认开（key 缺席）
    const db = getWebDb();
    await db
      .insert(siteSettingsForTest())
      .values({ key: "email.security", value: { enabled: false }, updatedAt: sqlNow() })
      .onDuplicateKeyUpdate({ set: { value: { enabled: false } } });
    expect(await securityEmailEnabled()).toBe(false);
  });

  it("userEmailEnabled：无记录 = 关；开/关行如实", async () => {
    const db = getWebDb();
    expect(await userEmailEnabled(90005, "pm.received")).toBe(false); // 无记录默认关
    await db
      .insert(prefsTable())
      .values({ userId: 90005, type: "pm.received", channel: "email", enabled: true })
      .onDuplicateKeyUpdate({ set: { enabled: true } });
    expect(await userEmailEnabled(90005, "pm.received")).toBe(true);
    await db.update(prefsTable()).set({ enabled: false }).where(andEq(90005, "pm.received"));
    expect(await userEmailEnabled(90005, "pm.received")).toBe(false);
  });

  it("pmEmailAllowed：同会话每小时 1 封（进程内频控）", async () => {
    expect(await pmEmailAllowed(90005, 777)).toBe(true);
    expect(await pmEmailAllowed(90005, 777)).toBe(false); // 同 key 立刻第二次被拦
    expect(await pmEmailAllowed(90005, 778)).toBe(true); // 不同会话不受影响
  });

  it("userActiveRecently：以最近会话 last_seen_at 判定", async () => {
    const db = getWebDb();
    const token = "activesessiontoken123456";
    await db
      .insert(sessionsTable())
      .values({
        id: sha256(token),
        userId: 90005,
        createdAt: sqlNow(),
        expiresAt: sqlLater(),
        lastSeenAt: sqlNow(),
      })
      .onDuplicateKeyUpdate({ set: { lastSeenAt: sqlNow() } });
    expect(await userActiveRecently(90005)).toBe(true);
    await db.delete(sessionsTable()).where(byId(sha256(token)));
    expect(await userActiveRecently(90005)).toBe(false);
  });
});

// ---- 局部工具（避免顶部杂音）----
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { notificationPreferences, sessions, siteSettings } from "@funwind/db";
function siteSettingsForTest() {
  return siteSettings;
}
function prefsTable() {
  return notificationPreferences;
}
function sessionsTable() {
  return sessions;
}
function sqlNow() {
  return sql`NOW()`;
}
function sqlLater() {
  return sql`NOW() + INTERVAL 1 HOUR`;
}
function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
function byId(id: string) {
  return eq(sessions.id, id);
}
function andEq(userId: number, type: string) {
  return and(
    eq(notificationPreferences.userId, userId),
    eq(notificationPreferences.type, type),
    eq(notificationPreferences.channel, "email"),
  );
}
