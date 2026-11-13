// @vitest-environment node
/**
 * Web Push 投递管线集成测试（M18 Step 2）· 真实临时库 + mock web-push。
 * 钉住：偏好「无行=关」、站点开关「无行=开」、多设备尽力而为、404/410 即时清理、90 天概率清扫。
 */
import { eq, sql } from "drizzle-orm";
import {
  getWebDb,
  notificationPreferences,
  pushLog,
  pushSubscriptions,
  sessions,
  siteSettings,
} from "@funwind/db";
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
  sendNotification,
  setVapidDetails: vi.fn(),
  WebPushError,
}));

const { sendPush, trySendPush } = await import("./transport");
const { pushEnabled, userPushEnabled, sendUserPush, trySendUserPush } = await import("./notify");
const { cleanupStalePushSubscriptions } = await import("./subscriptions");
const { queryPushLogs } = await import("./log-query");
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
  await db().delete(siteSettings).where(eq(siteSettings.key, "push.enabled"));
  await db().delete(sessions).where(eq(sessions.userId, UID));
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
      .insert(siteSettings)
      .values({ key: "push.enabled", value: { enabled: false }, updatedAt: sql`NOW()` });
    expect(await pushEnabled()).toBe(false);
  });
});

describe.skipIf(skipDb)("sendUserPush 多设备尽力而为", () => {
  it("无订阅返回 false，不调用 web-push，build 惰性不构造", async () => {
    const build = vi.fn(() => msg());
    expect(await sendUserPush(UID, build)).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled(); // 无订阅不白构造 payload
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

  it("410 同样删除订阅行并记 failed", async () => {
    await seedSub();
    sendNotification.mockRejectedValue(new WebPushError("gone", 410));
    expect(
      await trySendPush(
        { endpoint: "https://push.example.invalid/sub-1", p256dh: "k", auth: "a" },
        msg(),
        { userId: UID },
      ),
    ).toBe(false);
    expect(await db().select().from(pushSubscriptions)).toHaveLength(0);
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

describe.skipIf(skipDb)("VAPID 未配置错误路径", () => {
  it("密钥缺失 → trySendPush false + push_log 记 failed，不调 web-push", async () => {
    await seedSub();
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      expect(
        await trySendPush(
          { endpoint: "https://push.example.invalid/sub-1", p256dh: "k", auth: "a" },
          msg(),
          { userId: UID },
        ),
      ).toBe(false);
      const [log] = await db().select().from(pushLog);
      expect(log?.status).toBe("failed");
      expect(log?.error).toContain("VAPID");
      expect(sendNotification).not.toHaveBeenCalled();
    } finally {
      process.env.VAPID_PUBLIC_KEY = pub;
      process.env.VAPID_PRIVATE_KEY = priv;
    }
  });
});

describe.skipIf(skipDb)("订阅归属与越权防护", () => {
  it("用户 B 退订用户 A 的 endpoint → A 的行仍在（防越权删）", async () => {
    await seedSub("https://push.example.invalid/a-sub"); // 归属 UID
    const { unsubscribePush } = await import("./subscriptions");
    await unsubscribePush(UID + 1, "https://push.example.invalid/a-sub"); // 他人尝试删
    const subs = await db().select().from(pushSubscriptions);
    expect(subs).toHaveLength(1); // A 的订阅未被删
    expect(subs[0].userId).toBe(UID);
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

describe.skipIf(skipDb)("trySendUserPush 消费者门控（M18 Step 6）", () => {
  it("站点总开关关闭 → 不发（即便偏好开 + 有订阅）", async () => {
    await db()
      .insert(siteSettings)
      .values({ key: "push.enabled", value: { enabled: false }, updatedAt: sql`NOW()` });
    await seedPref("pm.received", true);
    await seedSub();
    sendNotification.mockResolvedValue({ statusCode: 201 });
    expect(await trySendUserPush(UID, "pm.received", () => msg(), 1)).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("偏好无行 = 关 → 不发", async () => {
    await seedSub();
    sendNotification.mockResolvedValue({ statusCode: 201 });
    expect(await trySendUserPush(UID, "pm.received", () => msg(), 1)).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("偏好开 + 有订阅 + 未活跃 → 发；同一会话频控第二次拦", async () => {
    await seedPref("pm.received", true);
    await seedSub();
    sendNotification.mockResolvedValue({ statusCode: 201 });
    expect(await trySendUserPush(UID, "pm.received", () => msg(), 7)).toBe(true);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    // 同一会话 1 小时内第二次 → 频控拦截（独立桶，不与邮件共享）
    expect(await trySendUserPush(UID, "pm.received", () => msg(), 7)).toBe(false);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("30 分钟内活跃 → 不发（活跃抑制）", async () => {
    await seedPref("pm.received", true);
    await seedSub();
    await db()
      .insert(sessions)
      .values({
        id: "push-active-session",
        userId: UID,
        createdAt: sql`NOW()`,
        expiresAt: sql`NOW() + INTERVAL 2 HOUR`,
        lastSeenAt: sql`NOW()`,
      });
    sendNotification.mockResolvedValue({ statusCode: 201 });
    expect(await trySendUserPush(UID, "pm.received", () => msg(), 8)).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe.skipIf(skipDb)("超期订阅卫生清扫（M18 Step 6）", () => {
  it("删超期订阅、保留新订阅", async () => {
    await db()
      .insert(pushSubscriptions)
      .values({
        userId: UID,
        endpoint: "https://push.example.invalid/old",
        p256dh: "k",
        auth: "a",
        createdAt: sql`NOW() - INTERVAL 200 DAY`,
      });
    await seedSub(); // 新订阅
    const removed = await cleanupStalePushSubscriptions();
    expect(removed).toBe(1);
    const endpoints = (
      await db().select({ e: pushSubscriptions.endpoint }).from(pushSubscriptions)
    ).map((r) => r.e);
    expect(endpoints).not.toContain("https://push.example.invalid/old");
    expect(endpoints).toContain("https://push.example.invalid/sub-1");
  });

  it("活跃订阅（创建超期但最近成功投递）不被误删（M18 Step 6.5 P1-1）", async () => {
    await db()
      .insert(pushSubscriptions)
      .values({
        userId: UID,
        endpoint: "https://push.example.invalid/active",
        p256dh: "k",
        auth: "a",
        createdAt: sql`NOW() - INTERVAL 200 DAY`,
        lastSentAt: sql`NOW() - INTERVAL 1 DAY`, // 最近投递活跃
      });
    const removed = await cleanupStalePushSubscriptions();
    expect(removed).toBe(0);
    const subs = await db().select().from(pushSubscriptions);
    expect(subs).toHaveLength(1); // 活跃订阅保留
  });

  it("投递成功刷新 lastSentAt", async () => {
    await seedSub();
    sendNotification.mockResolvedValue({ statusCode: 201, headers: {} });
    await sendUserPush(UID, () => msg());
    const [sub] = await db().select().from(pushSubscriptions);
    expect(sub.lastSentAt).not.toBeNull();
  });
});

describe.skipIf(skipDb)("queryPushLogs 筛选（q 数字→userId / 非数字→endpoint）", () => {
  const seedLog = (endpoint: string, userId: number) =>
    db()
      .insert(pushLog)
      .values({
        kind: "notice",
        scene: "pm-received",
        endpoint,
        userId,
        title: "t",
        status: "sent",
        createdAt: sql`NOW()`,
      });

  it("数字 q 精确匹配 userId；非数字 q 走 endpoint LIKE 且通配符被转义", async () => {
    await seedLog("https://push.example.invalid/alpha", UID);
    await seedLog("https://push.example.invalid/beta", UID + 1);
    const byUid = await queryPushLogs({ q: String(UID) });
    expect(byUid.total).toBe(1);
    expect(byUid.items[0].userId).toBe(UID);
    const byEndpoint = await queryPushLogs({ q: "alpha" });
    expect(byEndpoint.total).toBe(1);
    const wildcard = await queryPushLogs({ q: "%" }); // % 被转义，不匹配全部
    expect(wildcard.total).toBe(0);
  });
});
