import { and, eq, sql } from "drizzle-orm";
import { getWebDb, notificationPreferences, siteSettings, users } from "@funwind/db";
import { getMailBrand, trySendMail, type MailBrand, type MailMessage } from "@/lib/mail";
import { rateLimit } from "@/lib/auth/ratelimit";

/**
 * 通知邮件渠道（M10.6 收尾切片，docs/EMAIL-SCENARIOS.md）：
 *  · 安全强制类（S1 密码修改 / S2 邮箱换绑 / S3 账号限制）：**后台统一开关**（site_settings("email.security")，
 *    默认开），不查用户偏好——处罚送达与防盗号知情不因个人设置缺席。
 *  · 场景类（S4 私信 / S5 售出 / S6 审核通过 / S7 每日汇总）：**用户级 email 渠道偏好**，无记录 = 关
 *    （站内默认开、其它渠道默认关——数据模型既定口径）。
 *  · 发送恒为「尽力而为」：失败记日志与发送记录（email_log），不反噬主流程；模板在 lib/mail/templates.ts（纯函数）。
 */

export async function securityEmailEnabled(): Promise<boolean> {
  const [row] = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "email.security"))
    .limit(1);
  const v = row?.value as { enabled?: boolean } | undefined;
  return v?.enabled !== false;
}

/**
 * 运维告警邮件的后台统一开关（M17 Step 2）：与安全强制类同款——站点统一控制，不进用户偏好
 * （`ops.run.failed` 是 mandatory 类型，用户侧偏好清单里没有它）。
 * **默认开**：告警的价值就在于「不打开站点也能知道」，默认关等于没接线。
 */
export async function opsEmailEnabled(): Promise<boolean> {
  const [row] = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "email.ops"))
    .limit(1);
  const v = row?.value as { enabled?: boolean } | undefined;
  return v?.enabled !== false;
}

/** S7 发送时刻（0–23 点；进程内调度器 email.digest 每小时按北京墙面时间比对，M17 Step 1），默认 20 点 */
export async function getDigestHour(): Promise<number> {
  const [row] = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "email.digest"))
    .limit(1);
  const v = row?.value as { hour?: number } | undefined;
  return typeof v?.hour === "number" ? v.hour : 20;
}

/** 用户级邮件偏好：无记录 = 关 */
export async function userEmailEnabled(userId: number, type: string): Promise<boolean> {
  const [row] = await getWebDb()
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.type, type),
        eq(notificationPreferences.channel, "email"),
      ),
    )
    .limit(1);
  return row?.enabled === true;
}

/**
 * 给用户发一封通知邮件（尽力而为）：解析收件邮箱与邮件品牌，无邮箱返回 false；
 * 发送失败由 transport 记录（email_log + 日志）后返回 false。品牌走 chrome/目录 TTL 缓存，~0ms。
 */
export async function sendUserEmail(
  userId: number,
  build: (ctx: { email: string; brand: MailBrand }) => MailMessage,
): Promise<boolean> {
  try {
    const [row] = await getWebDb()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.email) return false;
    const brand = await getMailBrand();
    return await trySendMail(row.email, build({ email: row.email, brand }), { userId });
  } catch (e) {
    console.error(`[notify-email] 用户 ${userId} 邮件发送失败:`, e);
    return false;
  }
}

/** S4 频控：同一会话对同一收件人每小时最多 1 封 */
export async function pmEmailAllowed(userId: number, conversationId: number): Promise<boolean> {
  return rateLimit(`mail-pm:${userId}:${conversationId}`, 1, 60 * 60_000).allowed;
}

/** 30 分钟内活跃（任一会话 last_seen_at）则不发私信邮件——活跃用户看铃铛即可 */
export async function userActiveRecently(userId: number): Promise<boolean> {
  const [row] = await getWebDb()
    .select({ n: sql<number>`count(*)` })
    .from(
      sql`(SELECT 1 FROM sessions WHERE user_id = ${userId} AND last_seen_at > NOW() - INTERVAL 30 MINUTE LIMIT 1) t`,
    );
  return Number(row?.n ?? 0) > 0;
}
