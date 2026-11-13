// @vitest-environment node
/**
 * Web Push 投递管线集成测试（M18 Step 2）· 真实临时库 + mock web-push。
 * 钉住：偏好「无行=关」、站点开关「无行=开」、多设备尽力而为、404/410 即时清理、90 天概率清扫。
 */
import { sql } from "drizzle-orm";
import { getWebDb, notificationPreferences, pushLog, pushSubscriptions } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

// mock web-push：只替「真发送」一步，VAPID 配置空操作；WebPushError 带 statusCode 供 404/410 判定
const { sendNotification, WebPushError } = vi.hoisted(() => {
  class WebPushError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return { sendNotification: vi.fn(), WebPushError };
});
vi.mock("web-push", () => ({
  default: { sendNotification, setVapidDetails: vi.fn(), WebPushError },
}));

const { sendPush, trySendPush } = await import("./transport");
const { pushEnabled, userPushEnabled, sendUserPush } = await import("./notify");
import type { PushMessage } from "./types";

let tdb: TempDb;
const db = () => getWebDb();
const UID = 90001;

const msg = (over: Partial<PushMessage> = {}): PushMessage => ({
  kind: "notice",
  scene: "pm-received",
  title: "新私信",
  body: "你有一条新私信",
  url: "/messages",
  ...over,
});

const seedSub = (endpoint = "https://push.example.invalid/sub-1") =>
  db()
    .insert(pushSubscriptions)
    .values({
      userId: UID,
      endpoint,
      p256dh: "p256dh-key",
      auth: "auth-key",
      createdAt: sql`NOW()`,
    });

const seedPref = (type: string, enabled: boolean) =>
  db().insert(notificationPreferences).values({ userId: UID, type, channel: "push", enabled });

beforeAll(async () => {
  tdb = await setupTempDb();
  process.env.VAPID_PUBLIC_KEY = "test-public-key";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
  process.env.VAPID_SUBJECT = "mailto:test@example.com";
});
afterAll(async () => {
  await tdb?.teardown();
});
afterEach(async () => {
  await db()
    .delete(pushLog)
    .where(sql`1 = 1`);
  await db()
    .delete(pushSubscriptions)
    .where(sql`1 = 1`);
  await db()
    .delete(notificationPreferences)
    .where(sql`1 = 1`);
  sendNotification.mockReset();
  vi.restoreAllMocks();
});

describe.skipIf(skipDb)("用户偏好与站点开关默认值", () => {
  it("userPushEnabled：无行=关；enabled=true→true；enabled=false→false", async () => {
    expect(await userPushEnabled(UID, "pm.received")).toBe(false); // 无行=关（显式 opt-in）
    await seedPref("pm.received", true);
    expect(await userPushEnabled(UID, "pm.received")).toBe(true);
    await db()
      .update(notificationPreferences)
      .set({ enabled: false })
      .where(sql`1 = 1`);
    expect(await userPushEnabled(UID, "pm.received")).toBe(false);
  });

  it("pushEnabled：无行=开；enabled=false→关", async () => {
    expect(await pushEnabled()).toBe(true); // 无行=开（镜像 email.security）
    await db()
      .insert(notificationPreferences)
      .values({ userId: UID, type: "x", channel: "push", enabled: true }); // 占位避免空库
    const { siteSettings } = await import("@funwind/db");
    await db()
      .insert(siteSettings)
      .values({ key: "push.enabled", value: { enabled: false }, updatedAt: sql`NOW()` });
    expect(await pushEnabled()).toBe(false);
  });
});

describe.skipIf(skipDb)("sendUserPush 多设备尽力而为", () => {
  it("无订阅返回 false，不调用 web-push", async () => {
    expect(await sendUserPush(UID, () => msg())).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("有订阅则投递并写 push_log sent；多设备逐个发", async () => {
    await seedSub("https://push.example.invalid/a");
    await seedSub("https://push.example.invalid/b");
    sendNotification.mockResolvedValue({ statusCode: 201 });
    expect(await sendUserPush(UID, () => msg())).toBe(true);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const logs = await db().select().from(pushLog);
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.status === "sent")).toBe(true);
  });

  it("发送失败不反噬：返回 false 且写 failed", async () => {
    await seedSub();
    sendNotification.mockRejectedValue(new Error("push service down"));
    expect(await sendUserPush(UID, () => msg())).toBe(false);
    const [log] = await db().select().from(pushLog);
    expect(log?.status).toBe("failed");
  });
});

describe.skipIf(skipDb)("404/410 失效订阅即时清理", () => {
  it("404 删除订阅行并记 failed", async () => {
    await seedSub();
    sendNotification.mockRejectedValue(new WebPushError("gone", 404));
    expect(
      await trySendPush(
        { endpoint: "https://push.example.invalid/sub-1", p256dh: "k", auth: "a" },
        msg(),
        { userId: UID },
      ),
    ).toBe(false);
    const subs = await db().select().from(pushSubscriptions);
    expect(subs).toHaveLength(0); // 失效订阅已删
    const [log] = await db().select().from(pushLog);
    expect(log?.status).toBe("failed");
  });

  it("500 等非失效错误不删订阅", async () => {
    await seedSub();
    sendNotification.mockRejectedValue(new WebPushError("server error", 500));
    await sendPush(
      { endpoint: "https://push.example.invalid/sub-1", p256dh: "k", auth: "a" },
      msg(),
      { userId: UID },
    ).catch(() => undefined);
    const subs = await db().select().from(pushSubscriptions);
    expect(subs).toHaveLength(1); // 非 404/410 保留
  });
});

describe.skipIf(skipDb)("90 天写侧概率清扫", () => {
  const seedOld = () =>
    db()
      .insert(pushLog)
      .values({
        kind: "notice",
        scene: "old",
        endpoint: "https://push.example.invalid/old",
        userId: UID,
        title: "旧",
        status: "sent",
        createdAt: sql`NOW() - INTERVAL 100 DAY`,
      });

  it("触发删超期、保留新；不触发保留", async () => {
    await seedOld();
    await seedSub();
    sendNotification.mockResolvedValue({ statusCode: 201 });
    vi.spyOn(Math, "random").mockReturnValue(0); // 强制触发清扫
    await sendUserPush(UID, () => msg());
    let scenes = (await db().select({ s: pushLog.scene }).from(pushLog)).map((r) => r.s);
    expect(scenes).not.toContain("old");

    await db()
      .delete(pushLog)
      .where(sql`1 = 1`);
    await seedOld();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // 不触发
    await sendUserPush(UID, () => msg());
    scenes = (await db().select({ s: pushLog.scene }).from(pushLog)).map((r) => r.s);
    expect(scenes).toContain("old");
  });
});
