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
import { nowBeijingWallTime } from "@/lib/datetime";

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

/**
 * 当日幂等（M17 Step 1）：接进进程内调度器的前置条件。
 * 此前未读私信计数不受 since 时间窗约束，同日第二次运行会给有未读私信的用户再发一封——
 * 这正是 SCHEDULED-JOBS.md 当初「不迁调度器」的实质原因。命名锁只防并发，不防先后双跑。
 */
describe.skipIf(skipDb)("S7 当日幂等（M17 Step 1）", () => {
  /** 每个用例显式重置：上面的用例会把邮箱置空/改登录时间，共享临时库不能依赖前序状态 */
  const reset = async (lastDigestAt: string | null) => {
    const db = getWebDb();
    await db.delete(notifications).where(eq(notifications.userId, 90005));
    await db
      .update(users)
      .set({
        email: "digest-idempotence@example.com",
        state: "active",
        lastLoginAt: "2020-01-01 10:00:00",
        lastEmailDigestAt: lastDigestAt,
      })
      .where(eq(users.id, 90005));
    await db.insert(notifications).values({
      userId: 90005,
      type: "post.replied",
      category: "interaction",
      targetType: "thread",
      targetId: 1,
      data: { title: "t" },
      createdAt: sql`NOW()`,
    });
    sendMock.mockClear();
  };

  it("同日第二次运行：skippedToday 且不再发信（调度器与手动脚本先后双跑也安全）", async () => {
    await reset(null);
    const first = await runDigestOnce();
    expect(first.sent).toBeGreaterThanOrEqual(1);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const second = await runDigestOnce();
    expect(second.skippedToday).toBeGreaterThanOrEqual(1);
    expect(second.sent).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(1); // 关键：没有第二次发送
  });

  it("当日闸拦住同日重跑，force 放行（手动补发入口）", async () => {
    await reset(null);
    await runDigestOnce(); // 首发，落 lastDigestAt=NOW()
    sendMock.mockClear();
    // 把时间戳挪回今日零点：仍是「当日已发」，但通知 createdAt 晚于它 → 有内容可发。
    // 这样才能区分「被当日闸拦住」与「没有新动态所以不发」——后者不是闸的功劳。
    const todayStart = `${nowBeijingWallTime().slice(0, 10)} 00:00:00`;
    await getWebDb()
      .update(users)
      .set({ lastEmailDigestAt: todayStart })
      .where(eq(users.id, 90005));

    const blocked = await runDigestOnce();
    expect(blocked.skippedToday).toBeGreaterThanOrEqual(1);
    expect(blocked.sent).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();

    const forced = await runDigestOnce({ force: true });
    expect(forced.skippedToday).toBe(0);
    expect(forced.sent).toBeGreaterThanOrEqual(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("跨日（上次发送是往日）→ 正常发送，不被当日闸误拦", async () => {
    await reset("2020-01-01 20:00:00");
    const r = await runDigestOnce();
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(r.skippedToday).toBe(0);
  });

  it("发送失败计入 failed 且不写时间戳（下一轮可重试，不再静默丢弃）", async () => {
    await reset(null);
    sendMock.mockResolvedValueOnce(false);
    const r = await runDigestOnce();
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(r.sent).toBe(0);
    const [row] = await getWebDb()
      .select({ at: users.lastEmailDigestAt })
      .from(users)
      .where(eq(users.id, 90005));
    expect(row?.at).toBeNull();
  });
});

function sqlNowString(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
