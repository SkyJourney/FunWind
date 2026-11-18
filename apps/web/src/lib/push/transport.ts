import "server-only";
import { sendNotification, setVapidDetails, WebPushError } from "web-push";
import { and, eq, sql } from "drizzle-orm";
import { getWebDb, pushLog, pushSubscriptions } from "@funwind/db";
import { DeliveryTransportError } from "@/lib/net/delivery-error";
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

const SOCKET_TIMEOUT_MS = 10_000;
const RESPONSE_BUDGET_MS = 12_000;

let vapidReady = false;

/** 惰性配置 VAPID；此处失败发生在调用推送服务之前，因此明确未投递。 */
function ensureVapid(): void {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? "";
  if (!publicKey || !privateKey) throw new DeliveryTransportError("pushVapidMissing");
  if (!vapidReady) {
    try {
      setVapidDetails(
        process.env.VAPID_SUBJECT ?? "mailto:admin@qingyisub.top",
        publicKey,
        privateKey,
      );
    } catch {
      throw new DeliveryTransportError("pushVapidInvalid");
    }
    vapidReady = true;
  }
}

export interface PushSendMeta {
  /** 收件用户 id（能解析到时传入，后台可按用户追查） */
  userId?: number | null;
  /** 本次投递所用的订阅行 id；提供时可防止迟到的响应影响重建后的订阅。 */
  subscriptionId?: number;
}

export async function sendPush(
  sub: PushSubscriptionKeys,
  message: PushMessage,
  meta: PushSendMeta = {},
): Promise<void> {
  const started = Date.now();
  const { endpoint, p256dh, auth } = sub;
  const { userId, subscriptionId } = meta;
  const target = { endpoint, p256dh, auth, userId, subscriptionId };
  const base = {
    kind: message.kind,
    scene: message.scene,
    endpoint: endpoint.slice(0, 500),
    userId: userId ?? null,
    title: message.title.slice(0, 255),
  };
  let res: Awaited<ReturnType<typeof sendNotification>>;
  try {
    ensureVapid();
    res = await sendWithResponseBudget(
      target,
      JSON.stringify({ title: message.title, body: message.body, url: message.url }),
    );
  } catch (cause) {
    // 404/410 才清理，且不能删除投递期间换绑或重建的订阅。
    const statusCode: unknown =
      cause instanceof WebPushError
        ? Object.getOwnPropertyDescriptor(cause, "statusCode")?.value
        : undefined;
    if (statusCode === 404 || statusCode === 410) await deleteSubscription(target);
    const error =
      cause instanceof DeliveryTransportError
        ? cause
        : new DeliveryTransportError(
            isExplicitRejection(statusCode) ? "pushRejected" : "pushUncertain",
          );
    await record({
      ...base,
      status: "failed",
      error: error.message,
      durationMs: Date.now() - started,
    });
    console.error(`[push] ${error.message}`);
    throw error;
  }
  // web-push 只在 2xx 时 resolve；之后的日志与订阅维护不再影响投递结果。
  await record({
    ...base,
    status: "sent",
    messageId: String(res.headers?.location ?? res.statusCode).slice(0, 255),
    durationMs: Date.now() - started,
  });
  await markSubscriptionActive(target);
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

/** SDK 超时只限制 socket 空闲；总预算只限制应用等待，不撤销服务商可能已接纳的投递。 */
async function sendWithResponseBudget(
  { endpoint, p256dh, auth }: PushSubscriptionKeys,
  payload: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DeliveryTransportError("pushUncertain")),
      RESPONSE_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([
      deadline,
      sendNotification({ endpoint, keys: { p256dh, auth } }, payload, {
        timeout: SOCKET_TIMEOUT_MS,
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 服务端或网关可能已转发，5xx、超时及断连均不能证明未接纳。 */
function isExplicitRejection(statusCode: unknown): boolean {
  return (
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408 &&
    statusCode !== 499
  );
}

type DeliveryTarget = PushSubscriptionKeys & PushSendMeta;

/** 仅匹配投递时的订阅快照；二进制比较避免默认不区分大小写的排序规则误匹配密钥。 */
function subscriptionMatch(target: DeliveryTarget) {
  return and(
    eq(pushSubscriptions.endpoint, target.endpoint),
    sql`${pushSubscriptions.endpoint} = CAST(${target.endpoint} AS BINARY)`,
    sql`${pushSubscriptions.p256dh} = CAST(${target.p256dh} AS BINARY)`,
    sql`${pushSubscriptions.auth} = CAST(${target.auth} AS BINARY)`,
    target.userId == null ? undefined : eq(pushSubscriptions.userId, target.userId),
    target.subscriptionId == null ? undefined : eq(pushSubscriptions.id, target.subscriptionId),
  );
}

/** 删除失效订阅（404/410 即时清理）；失败只记录固定诊断。 */
async function deleteSubscription(target: DeliveryTarget): Promise<void> {
  try {
    await getWebDb().delete(pushSubscriptions).where(subscriptionMatch(target));
  } catch {
    console.error("[push] 失效订阅清理失败");
  }
}

/** 刷新订阅活跃时间，避免卫生清扫误删；失败不改变投递结果。 */
async function markSubscriptionActive(target: DeliveryTarget): Promise<void> {
  try {
    await getWebDb()
      .update(pushSubscriptions)
      .set({ lastSentAt: sql`NOW()` })
      .where(subscriptionMatch(target));
  } catch {
    console.error("[push] 更新订阅最后投递时间失败");
  }
}

type PushLogInsert = Omit<typeof pushLog.$inferInsert, "createdAt" | "id">;

async function record(row: PushLogInsert): Promise<void> {
  try {
    await getWebDb()
      .insert(pushLog)
      .values({ ...row, createdAt: sql`NOW()` });
    if (Math.random() < SWEEP_PROBABILITY) await sweepExpired();
  } catch {
    console.error("[push] 写入发送记录或清理历史记录失败");
  }
}

/** 清理超过保留期的记录；小批量 LIMIT 避免长事务 */
async function sweepExpired(): Promise<void> {
  await getWebDb().execute(
    sql`DELETE FROM push_log WHERE created_at < NOW() - INTERVAL ${sql.raw(String(RETENTION_DAYS))} DAY LIMIT 1000`,
  );
}
