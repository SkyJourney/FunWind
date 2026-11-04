import "server-only";

import { and, eq } from "drizzle-orm";
import { getWebDb, normalizeKey, users } from "@funwind/db";
import {
  FALLBACK_BRAND,
  getMailBrand,
  sendMail,
  verifyEmailMail,
  type MailBrand,
} from "@/lib/mail";
import { MAX_EMAIL_LENGTH } from "./email";
import { rateLimit } from "./ratelimit";
import { issueEmailToken } from "./tokens";

/**
 * 免登录重发验证邮件（M11.3）：登录验证门把没验证的用户挡在门外，而原有的重发入口在「设置 → 邮箱」，
 * 需要先登录——没有这个入口，邮件丢了的用户就被永久锁死。
 *
 * 照搬 forgot.ts 的结构，那里已经解决了防枚举：
 *  · 响应前只做一次按邮箱的查库（存在与否耗时相同），签发令牌与发信一律交给 defer（生产里是 after()）；
 *  · 无论结果如何调用方都跳到同一个中性视图，响应时间与邮箱是否存在、是否待验证无关。
 *
 * 与找回密码的区别：
 *  · **只对「登录验证门仍然关着」的账号发信**（login_verification_required 为真）。邮箱不存在、已验证、
 *    本来就不需要验证的账号一律静默返回——这个入口不能被拿来给任意人发邮件，也不能当作账号探测器。
 *  · 限流用独立前缀（resend-verify:），不与找回密码共享额度：互不挤占，也避免一个入口被刷满后另一个同时失效。
 */

export const RESEND_VERIFY_LIMITS = {
  ip: { max: 5, windowMs: 15 * 60_000 },
  global: { max: 60, windowMs: 15 * 60_000 },
  cooldown: { max: 1, windowMs: 2 * 60_000 },
  hourly: { max: 6, windowMs: 60 * 60_000 },
} as const;

export interface ResendVerificationDeps {
  /** 响应之后执行的任务（生产：Next 的 after()）；单测注入以验证「响应不等发信」 */
  defer: (task: () => Promise<void>) => void;
  /** 为该用户签发令牌并发信；缺省走真实令牌与邮件（brand 由调用方预取，避免 after() 内做首个 DB 查询） */
  deliver?: (user: { id: number }, email: string, brand?: MailBrand) => Promise<void>;
}

async function defaultDeliver(
  user: { id: number },
  email: string,
  brand: MailBrand = FALLBACK_BRAND,
) {
  const token = await issueEmailToken(user.id, "verify", normalizeKey(email));
  // sendMail 失败抛错（先记 email_log），由外层 defer 的 catch 统一记日志
  await sendMail(email, verifyEmailMail(`${brand.siteUrl}/verify/${token}`, brand, { email }), {
    userId: user.id,
  });
}

/** 无论结果如何都返回 void：调用方一律跳转到同一个中性视图 */
export async function requestVerificationResend(
  rawEmail: string,
  ip: string | null,
  deps: ResendVerificationDeps,
): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (email === "" || email.length > MAX_EMAIL_LENGTH) return;

  // 有可信 IP：按 IP 限额，在查库之前（对所有输入一视同仁）
  const { ip: ipLimit, cooldown, hourly, global } = RESEND_VERIFY_LIMITS;
  if (ip !== null && !rateLimit(`resend-verify:${ip}`, ipLimit.max, ipLimit.windowMs).allowed) {
    return;
  }

  const rows = await getWebDb()
    .select({ id: users.id, gated: users.loginVerificationRequired })
    .from(users)
    .where(and(eq(users.emailKey, normalizeKey(email)), eq(users.state, "active")))
    .limit(1);
  const user = rows[0];
  // 不存在 / 已验证（标记已清除）/ 本来就不需要验证：静默返回，与「被限额丢弃」对外不可区分
  if (!user || !user.gated) return;

  if (
    !rateLimit(`resend-verify-cooldown:${user.id}`, cooldown.max, cooldown.windowMs).allowed ||
    !rateLimit(`resend-verify-hour:${user.id}`, hourly.max, hourly.windowMs).allowed
  ) {
    return;
  }
  // 无可信 IP 时只剩全局兜底桶；它只对真实待验证账号且通过了账号级额度的请求计数（同 forgot.ts 的论证），
  // 随机邮箱烧不掉它，要占满得知道一批互不相同的真实待验证邮箱
  if (ip === null && !rateLimit("resend-verify-global", global.max, global.windowMs).allowed) {
    return;
  }

  const deliver = deps.deliver ?? defaultDeliver;
  // 邮件品牌预取（M10.6c 教训）：放请求内是缓存命中；放 after() 里会拖慢投递。对所有邮箱一视同仁地读。
  const brand = await getMailBrand();
  deps.defer(async () => {
    try {
      await deliver({ id: user.id }, email, brand);
    } catch (e) {
      // 响应早已发出，这里只能记日志；用户重新申请即可
      console.error("[auth] 重发验证邮件失败:", e);
    }
  });
}
