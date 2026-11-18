import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getWebDb, pushSubscriptions, siteSettings } from "@funwind/db";
import { rateLimit } from "@/lib/auth/ratelimit";
import { channelPreferenceEnabled, userActiveRecently } from "@/lib/notifications/email";
import { deliverModerationNotification } from "@/lib/notifications/delivery";
import { DeliveryTransportError } from "@/lib/net/delivery-error";
import { sendPush, trySendPush } from "./transport";
import type { PushMessage } from "./types";

/**
 * Web Push 通知渠道（M18，镜像 lib/notifications/email.ts）：
 *  · 站点级总开关 site_settings("push.enabled")，默认开（出问题可一键停推，镜像 email.security）。
 *  · 用户级 push 渠道偏好，**无记录 = 关**（显式 opt-in，与 email 同口径、与 in_app 相反）。
 *  · 发送恒为「尽力而为」：失败记 push_log 与日志，不反噬主流程；多设备订阅逐个投递。
 *  · 活跃抑制复用 email.ts 的 userActiveRecently（渠道无关：30 分钟内活跃看铃铛即可）。
 */

/** 站点级推送总开关：无记录 = 开（镜像 securityEmailEnabled） */
export async function pushEnabled(): Promise<boolean> {
  const [row] = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "push.enabled"))
    .limit(1);
  const v = row?.value as { enabled?: boolean } | undefined;
  return v?.enabled !== false;
}

/** 用户级推送偏好：无记录 = 关（显式 opt-in，复用 channelPreferenceEnabled，不能抄 in_app 的 ?? true） */
export async function userPushEnabled(userId: number, type: string): Promise<boolean> {
  return channelPreferenceEnabled(userId, type, "push");
}

/**
 * 给用户的所有订阅设备发一条推送（尽力而为）：无订阅返回 false；
 * 任一设备送达即返回 true。发送失败由 transport 记录（push_log + 日志），整体 try/catch 永不抛出。
 * build 惰性构造 payload——仅在确有订阅时调用，避免无订阅用户白构造。
 */
export async function sendUserPush(
  userId: number,
  build: () => PushMessage | Promise<PushMessage>,
): Promise<boolean> {
  try {
    const subs = await loadUserSubscriptions(userId);
    if (subs.length === 0) return false;
    const message = await build();
    let anySent = false;
    for (const sub of subs) {
      if (await trySendPush(sub, message, { userId })) anySent = true;
    }
    return anySent;
  } catch {
    console.error("[notify-push] push_prepare_failed", { userId });
    return false;
  }
}

function loadUserSubscriptions(userId: number) {
  return getWebDb()
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(asc(pushSubscriptions.id));
}

async function canSendUserPush(userId: number, type: string): Promise<boolean> {
  return (
    (await pushEnabled()) &&
    (await userPushEnabled(userId, type)) &&
    !(await userActiveRecently(userId))
  );
}

/** 审核补发的回复按订阅独立占位；前置失败交给出箱，发送后的结果由凭证吸收。 */
export async function sendModerationReplyPush(outboxId: number, userId: number): Promise<void> {
  if (!(await canSendUserPush(userId, "post.replied"))) return;
  const subs = await loadUserSubscriptions(userId);
  // 设备可在发送期间换绑，系统通知不带主题标题、编号或正文，详情仍按站内权限读取。
  const message: PushMessage = {
    kind: "notice",
    scene: "post-replied",
    title: "站内通知",
    body: "请在站内查看通知。",
    url: "/notifications",
  };
  for (const { id, ...sub } of subs) {
    await deliverModerationNotification(
      { outboxId, channel: "push", scene: "post.replied", recipientId: id },
      async () => {
        const [current] = await getWebDb()
          .select({
            endpoint: pushSubscriptions.endpoint,
            p256dh: pushSubscriptions.p256dh,
            auth: pushSubscriptions.auth,
          })
          .from(pushSubscriptions)
          .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
          .limit(1);
        if (
          !current ||
          current.endpoint !== sub.endpoint ||
          current.p256dh !== sub.p256dh ||
          current.auth !== sub.auth
        ) {
          throw new DeliveryTransportError("pushSubscriptionChanged");
        }
        await sendPush(sub, message, { userId, subscriptionId: id });
      },
    );
  }
}

/** 私信频控：同一会话对同一收件人每小时最多 1 条（独立桶，不与邮件共享额度，镜像 pmEmailAllowed） */
export async function pmPushAllowed(userId: number, conversationId: number): Promise<boolean> {
  return rateLimit(`push-pm:${userId}:${conversationId}`, 1, 60 * 60_000).allowed;
}

/**
 * 消费者并联推送的统一入口（M18 Step 6）：站点总开关 → 用户偏好 → 活跃抑制 →（私信会话频控），
 * 全过才发。**整体 try/catch 永不抛出**——推送是站内通知的附带渠道，其故障不能让已提交的
 * 站内通知事件经 outbox 重放（镜像 pm/index.ts 邮件附带渠道的隔离口径）。
 * 活跃抑制先于频控：活跃用户看铃铛即可，不白耗该会话当小时唯一额度（M18 Step 6.5）。
 * conversationId 仅私信传入（施加每会话每小时 1 条频控）；回复/提及不传。
 */
export async function trySendUserPush(
  userId: number,
  type: string,
  build: () => PushMessage | Promise<PushMessage>,
  conversationId?: number,
): Promise<boolean> {
  try {
    if (!(await canSendUserPush(userId, type))) return false;
    if (conversationId !== undefined && !(await pmPushAllowed(userId, conversationId)))
      return false;
    return await sendUserPush(userId, build);
  } catch {
    console.error("[notify-push] push_channel_failed", { userId });
    return false;
  }
}

// 活跃抑制直接复用 email.ts 的 userActiveRecently（渠道无关），此处再导出方便消费者单一入口取齐三关
export { userActiveRecently };
