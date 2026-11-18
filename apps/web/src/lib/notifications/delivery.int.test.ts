// @vitest-environment node
import "@/modules";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEMO,
  eventOutbox,
  getWebDb,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  pushSubscriptions,
} from "@funwind/db";
import { drainOutbox, enqueueEventInTx } from "@/lib/events/outbox";
import { DeliveryTransportError } from "@/lib/net/delivery-error";
import { MODERATION_NOTIFICATION_DELIVERY_POLICY as policy } from "@/modules/kernel/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { deliverModerationNotification } from "./delivery";

const sends = vi.hoisted(() => ({ email: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/mail/transport", async (original) => ({
  ...(await original<typeof import("@/lib/mail/transport")>()),
  sendMail: sends.email,
  trySendMail: sends.email,
}));
vi.mock("@/lib/push/transport", async (original) => ({
  ...(await original<typeof import("@/lib/push/transport")>()),
  sendPush: sends.push,
  trySendPush: sends.push,
}));

const db = () => getWebDb();
const approved = { postId: 900107, operatorId: DEMO.admin, action: "approve" } as const;
const reply = {
  threadId: 900002,
  postId: 990260,
  forumId: 902,
  authorId: DEMO.member,
  threadAuthorId: DEMO.xiaoyi,
};
const opts = { source: "moderation", deliveryPolicy: policy } as const;
const approval = () => enqueueEventInTx(db(), "content.moderated", approved, opts);
const replay = (id: number) =>
  db().update(eventOutbox).set({ dispatchedAt: null }).where(eq(eventOutbox.id, id));
const deliveries = (id: number) =>
  db().select().from(notificationDeliveries).where(eq(notificationDeliveries.outboxId, id));

function enable(userId: number, type: string, channel: "email" | "push") {
  const enabled = true;
  return db()
    .insert(notificationPreferences)
    .values({ userId, type, channel, enabled })
    .onDuplicateKeyUpdate({ set: { enabled } });
}

let tdb: TempDb;
describe.skipIf(skipDb)("审核外送台账（真实 MySQL，模拟服务商）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });
  beforeEach(() => {
    sends.email.mockReset().mockResolvedValue(undefined);
    sends.push.mockReset().mockResolvedValue(undefined);
  });

  it("并发补派与完成标记丢失都不会重复发送审核通过邮件", async () => {
    await enable(DEMO.xiaoyi, "content.approved", "email");
    const row = await approval();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    sends.email.mockImplementation(async () => {
      started.resolve();
      await release.promise;
    });
    const first = drainOutbox({ limit: 1 });
    try {
      // 让第二次补派确定碰到尚未标记完成、但外送占位已提交的同一行。
      await Promise.race([
        started.promise,
        first.then(() => {
          throw new Error("未进入模拟发送");
        }),
      ]);
      expect(await deliveries(row.id)).toMatchObject([{ status: "uncertain", finishedAt: null }]);
      expect(await drainOutbox({ limit: 1 })).toMatchObject({ dispatched: 1, failed: 0 });
    } finally {
      release.resolve();
      await first;
    }
    expect(sends.email).toHaveBeenCalledTimes(1);
    expect(await deliveries(row.id)).toMatchObject([
      { channel: "email", recipientId: DEMO.xiaoyi, status: "sent" },
    ]);
    await replay(row.id);
    await drainOutbox();
    expect(sends.email).toHaveBeenCalledTimes(1);
  });

  it("不同设备分别记录；明确拒绝与结果不明均不自动重试", async () => {
    await enable(DEMO.xiaoyi, "post.replied", "push");
    for (const suffix of ["ok", "rejected", "uncertain", "rebound"]) {
      await db()
        .insert(pushSubscriptions)
        .values({
          userId: DEMO.xiaoyi,
          endpoint: `https://push.test/${suffix}`,
          p256dh: "fake-key",
          auth: "fake-auth",
          createdAt: sql`NOW()`,
        });
    }
    sends.push.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("/ok")) {
        await db()
          .update(pushSubscriptions)
          .set({ userId: DEMO.admin })
          .where(eq(pushSubscriptions.endpoint, "https://push.test/rebound"));
      }
      if (sub.endpoint.endsWith("/rejected")) throw new DeliveryTransportError("pushRejected");
      if (sub.endpoint.endsWith("/uncertain")) throw new Error("合成的不可记录响应");
    });
    const row = await enqueueEventInTx(db(), "thread.replied", reply, opts);
    await drainOutbox();
    expect(sends.push).toHaveBeenCalledTimes(3);
    expect(
      sends.push.mock.calls.every(
        ([sub, message]) =>
          !sub.endpoint.endsWith("/rebound") &&
          message.title === "站内通知" &&
          message.body === "请在站内查看通知。" &&
          message.url === "/notifications",
      ),
    ).toBe(true);
    const first = await deliveries(row.id);
    expect(first.map((d) => d.status).sort()).toEqual(["failed", "failed", "sent", "uncertain"]);
    expect(new Set(first.map((d) => d.recipientId)).size).toBe(4);
    await replay(row.id);
    await drainOutbox();
    expect(sends.push).toHaveBeenCalledTimes(3);
    expect(await deliveries(row.id)).toEqual(first);
    const [notice] = await db()
      .select({ data: notifications.data })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, DEMO.xiaoyi),
          eq(notifications.groupKey, `thread:${reply.threadId}:replied`),
        ),
      );
    expect(notice.data).toMatchObject({ count: 1 });
  });

  it("占位失败不发；传输接纳后结果未写回也不重发", async () => {
    const row = await approval();
    const input = {
      outboxId: row.id,
      channel: "email",
      scene: "content.approved",
      recipientId: DEMO.xiaoyi,
    } as const;
    const send = vi.fn().mockResolvedValue(undefined);
    await db().execute(
      sql`CREATE TRIGGER fail_delivery_reserve BEFORE INSERT ON notification_deliveries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '合成错误标记'`,
    );
    try {
      await expect(deliverModerationNotification(input, send)).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    } finally {
      await db().execute(sql`DROP TRIGGER fail_delivery_reserve`);
    }
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await db().execute(
      sql`CREATE TRIGGER fail_delivery_result BEFORE UPDATE ON notification_deliveries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '合成错误标记'`,
    );
    try {
      await expect(deliverModerationNotification(input, send)).resolves.toBe(true);
      expect(await deliveries(row.id)).toMatchObject([{ status: "uncertain", finishedAt: null }]);
      await expect(deliverModerationNotification(input, send)).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain("合成错误标记");
    } finally {
      stderr.mockRestore();
      await db().execute(sql`DROP TRIGGER fail_delivery_result`);
      await db()
        .update(eventOutbox)
        .set({ dispatchedAt: sql`NOW()` })
        .where(eq(eventOutbox.id, row.id));
    }
  });

  it("过期事件即使没有台账也不外送；用户关闭偏好不占位", async () => {
    const row = await approval();
    await db()
      .update(eventOutbox)
      .set({ createdAt: sql`NOW() - INTERVAL 91 DAY` })
      .where(eq(eventOutbox.id, row.id));
    await drainOutbox();
    expect(sends.email).not.toHaveBeenCalled();
    expect(await deliveries(row.id)).toHaveLength(0);
    await db()
      .update(notificationPreferences)
      .set({ enabled: false })
      .where(
        and(
          eq(notificationPreferences.userId, DEMO.xiaoyi),
          eq(notificationPreferences.type, "content.approved"),
        ),
      );
    const off = await approval();
    await drainOutbox();
    expect(sends.email).not.toHaveBeenCalled();
    expect(await deliveries(off.id)).toHaveLength(0);
  });
});
