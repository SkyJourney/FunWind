import "server-only";
import webpush from "web-push";
import { eq, sql } from "drizzle-orm";
import { getWebDb, pushLog, pushSubscriptions } from "@funwind/db";
import type { PushMessage, PushSubscriptionKeys } from "./types";

/**
 * Web Push 发送（VAPID 驱动，web-push 协议库）+ 发送记录（M18，镜像 lib/mail/transport.ts）。
 *
 * 每次发送成败都写一行 push_log（推送通道审计日志，后台 /admin/push 可查）；
 * 记录只含 endpoint / 标题 / 场景 / 结果，**不含正文 payload**。记录落库失败只打日志，绝不反噬发送。
 *
 * 两个入口（照邮件）：
 *  · sendPush    失败先记 failed 再抛出——调用方自行决定处置
 *  · trySendPush 尽力而为，失败返回 false——通知镜像类用它
 *
 * 失效订阅：推送服务返回 404/410（订阅已失效）时即时删除 push_subscriptions 行，避免堆积。
 */

/** 发送记录保留天数；超期行由发送侧概率触发清理 */
const RETENTION_DAYS = 90;
const SWEEP_PROBABILITY = 0.01;

let vapidReady = false;

/** 惰性配置 VAPID（密钥只在 env，不入库）；未配置返回 false，调用方据此跳过发送 */
function ensureVapid(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? "";
  if (!publicKey || !privateKey) return false;
  if (!vapidReady) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT ?? "mailto:admin@qingyisub.top",
      publicKey,
      privateKey,
    );
    vapidReady = true;
  }
  return true;
}

export interface PushSendMeta {
  /** 收件用户 id（能解析到时传入，后台可按用户追查） */
  userId?: number | null;
}

export async function sendPush(
  sub: PushSubscriptionKeys,
  message: PushMessage,
  meta: PushSendMeta = {},
): Promise<void> {
  const started = Date.now();
  const base = {
    kind: message.kind,
    scene: message.scene,
    endpoint: sub.endpoint.slice(0, 500),
    userId: meta.userId ?? null,
    title: message.title.slice(0, 255),
  };
  if (!ensureVapid()) {
    await record({ ...base, status: "failed", error: "VAPID 密钥未配置", durationMs: 0 });
    throw new Error("VAPID 密钥未配置，跳过推送");
  }
  try {
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ title: message.title, body: message.body, url: message.url }),
    );
    await record({
      ...base,
      status: "sent",
      messageId: String(res.statusCode).slice(0, 255),
      durationMs: Date.now() - started,
    });
  } catch (e) {
    // 404/410 = 订阅已失效（用户退订/浏览器过期）：即时清理，避免反复投递失效 endpoint
    const statusCode = e instanceof webpush.WebPushError ? e.statusCode : undefined;
    if (statusCode === 404 || statusCode === 410) {
      await deleteSubscription(sub.endpoint);
    }
    await record({
      ...base,
      status: "failed",
      error: String(e instanceof Error ? e.message : e).slice(0, 500),
      durationMs: Date.now() - started,
    });
    console.error(`[push] ${message.scene} 发送失败:`, e);
    throw e;
  }
}

export async function trySendPush(
  sub: PushSubscriptionKeys,
  message: PushMessage,
  meta: PushSendMeta = {},
): Promise<boolean> {
  try {
    await sendPush(sub, message, meta);
    return true;
  } catch {
    return false;
  }
}

/** 删除失效订阅（404/410 即时清理）；失败只打日志，不反噬发送 */
async function deleteSubscription(endpoint: string): Promise<void> {
  try {
    await getWebDb().delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  } catch (e) {
    console.error("[push] 失效订阅清理失败:", e);
  }
}

type PushLogInsert = Omit<typeof pushLog.$inferInsert, "createdAt" | "id">;

async function record(row: PushLogInsert): Promise<void> {
  try {
    await getWebDb()
      .insert(pushLog)
      .values({ ...row, createdAt: sql`NOW()` });
    if (Math.random() < SWEEP_PROBABILITY) await sweepExpired();
  } catch (e) {
    console.error("[push] 发送记录落库失败:", e);
  }
}

/** 清理超过保留期的记录；小批量 LIMIT 避免长事务 */
async function sweepExpired(): Promise<void> {
  await getWebDb().execute(
    sql`DELETE FROM push_log WHERE created_at < NOW() - INTERVAL ${sql.raw(String(RETENTION_DAYS))} DAY LIMIT 1000`,
  );
}
