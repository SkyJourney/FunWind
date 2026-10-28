// @vitest-environment node
/**
 * S7 每日汇总管线集成测试（M10.6 收尾切片）：opt-in 圈定、活跃 24h 跳过、无邮箱跳过、
 * 零动态刷新时间戳不发送、有动态发送并落 last_email_digest_at。
 * sendUserEmail 以 vi.mock 注入（不发真信），计数与时间戳为本测试断言对象。
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getWebDb, notificationPreferences, notifications, users } from "@funwind/db";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

const sendMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email")>()),
  sendUserEmail: sendMock,
}));

const { runDigestOnce } = await import("./digest");

let tdb: TempDb;

beforeAll(async () => {
  tdb = await setupTempDb({ demo: true });
  // digest 目标账号：有邮箱 + opt-in + 24h 前登录（不活跃 → 可发）
  const db = getWebDb();
  await db
    .update(users)
    .set({
      lastLoginAt: "2020-01-01 10:00:00",
      lastEmailDigestAt: null,
    })
    .where(eq(users.id, 90005));
  await db
    .insert(notificationPreferences)
    .values({ userId: 90005, type: "email.digest", channel: "email", enabled: true })
    .onDuplicateKeyUpdate({ set: { enabled: true } });
  sendMock.mockClear();
});

afterAll(() => {
  tdb?.teardown();
});

describe.skipIf(skipDb)("S7 每日汇总管线（M10.6 收尾切片）", () => {
  it("opt-in + 有未读 + 不活跃 → 发送并落 last_email_digest_at", async () => {
    // 造一条未读互动通知（digest 计数来源；直接写表，聚焦管线判定本身）
    await getWebDb()
      .insert(notifications)
      .values({
        userId: 90005,
        type: "post.replied",
        category: "interaction",
        targetType: "thread",
        targetId: 1,
        data: { title: "t" },
        createdAt: sql`NOW()`,
      });
    const r = await runDigestOnce();
    expect(r.checked).toBeGreaterThanOrEqual(1);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(sendMock).toHaveBeenCalled();
    const [row] = await getWebDb()
      .select({ at: users.lastEmailDigestAt })
      .from(users)
      .where(eq(users.id, 90005));
    expect(row?.at).not.toBeNull();
  });

  it("活跃 24h 内 → 跳过（不发送）", async () => {
    const db = getWebDb();
    await db
      .update(users)
      .set({ lastLoginAt: sqlNowString(), lastEmailDigestAt: null })
      .where(eq(users.id, 90005));
    const r = await runDigestOnce();
    expect(r.skippedActive).toBeGreaterThanOrEqual(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("零动态 → 不发送但刷新时间戳", async () => {
    const db = getWebDb();
    await db.delete(notifications).where(eq(notifications.userId, 90005)); // 清掉上一用例的未读
    await db
      .update(users)
      .set({ lastLoginAt: "2020-01-01 10:00:00", lastEmailDigestAt: null })
      .where(eq(users.id, 90005));
    const r = await runDigestOnce();
    expect(r.sent).toBe(0); // demo 库该账号无未读互动通知
    const [row] = await getWebDb()
      .select({ at: users.lastEmailDigestAt })
      .from(users)
      .where(eq(users.id, 90005));
    expect(row?.at).not.toBeNull();
  });

  it("无邮箱账号 → skippedNoEmail", async () => {
    const db = getWebDb();
    await db
      .update(users)
      .set({ email: null, lastLoginAt: "2020-01-01 10:00:00" })
      .where(eq(users.id, 90005));
    const r = await runDigestOnce();
    expect(r.skippedNoEmail).toBeGreaterThanOrEqual(1);
  });
});

function sqlNowString(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
