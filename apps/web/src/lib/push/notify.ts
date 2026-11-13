import "server-only";
import { eq } from "drizzle-orm";
import { getWebDb, pushSubscriptions, siteSettings } from "@funwind/db";
import { rateLimit } from "@/lib/auth/ratelimit";
import { channelPreferenceEnabled, userActiveRecently } from "@/lib/notifications/email";
import { trySendPush } from "./transport";
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
    const subs = await getWebDb()
      .select({
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    if (subs.length === 0) return false;
    const message = await build();
    let anySent = false;
    for (const sub of subs) {
      if (await trySendPush(sub, message, { userId })) anySent = true;
    }
    return anySent;
  } catch (e) {
    console.error(`[notify-push] 用户 ${userId} 推送发送失败:`, e);
    return false;
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
    if (!(await pushEnabled())) return false;
    if (!(await userPushEnabled(userId, type))) return false;
    if (await userActiveRecently(userId)) return false;
    if (conversationId !== undefined && !(await pmPushAllowed(userId, conversationId)))
      return false;
    return await sendUserPush(userId, build);
  } catch (e) {
    console.error(`[notify-push] 用户 ${userId} ${type} 推送附带渠道失败:`, e);
    return false;
  }
}

// 活跃抑制直接复用 email.ts 的 userActiveRecently（渠道无关），此处再导出方便消费者单一入口取齐三关
export { userActiveRecently };
