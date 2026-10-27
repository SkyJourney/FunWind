import { and, eq } from "drizzle-orm";
import { getWebDb, normalizeKey, users } from "@funwind/db";
import { APP_URL } from "@/lib/site";
import { getSiteIdentity } from "@/lib/site-chrome";
import { claimMail, resetPasswordMail, sendMail } from "./mailer";
import { MAX_EMAIL_LENGTH } from "./email";
import { rateLimit } from "./ratelimit";
import { issueEmailToken } from "./tokens";

/**
 * 找回密码 / 认领账号的发信判定（M5.6 S3）。Server Action 只负责取表单、调用本函数、跳转到中性视图。
 *
 * 防枚举（时序）：旧实现对存在的邮箱会 await 签发令牌 + 发信，响应明显比不存在的邮箱慢，能枚举注册邮箱。
 * 现在响应前只做一次按邮箱的查库（存在与否耗时相同），签发令牌与发信一律交给 defer（生产里是 Next 的 after()，
 * 响应发出之后才执行），响应时间与邮箱是否存在无关。
 *
 * 频控：有可信 IP 按 IP 限额；取不到时退回全局兜底桶，但它只对真实账号计数（见下），避免被一个客户端占满。
 * 按账号另有 2 分钟 1 封 + 每小时 6 封：只对真实存在的账号计数（限额表不会被任意输入撑大），
 * 被限额丢弃的请求不签发新令牌——这不会让人把别人锁在外面（令牌共存，见 tokens.ts）。
 */

export const FORGOT_LIMITS = {
  ip: { max: 5, windowMs: 15 * 60_000 },
  global: { max: 60, windowMs: 15 * 60_000 },
  cooldown: { max: 1, windowMs: 2 * 60_000 },
  hourly: { max: 6, windowMs: 60 * 60_000 },
} as const;

export interface ForgotDeps {
  /** 响应之后执行的任务（生产：Next 的 after()）；单测注入以验证“响应不等发信” */
  defer: (task: () => Promise<void>) => void;
  /** 为该用户签发令牌并发信；缺省走真实令牌与邮件（siteName 由调用方预取，避免 after() 内做首个 DB 查询） */
  deliver?: (
    user: { id: number; hasPassword: boolean },
    email: string,
    siteName?: string,
  ) => Promise<void>;
}

async function defaultDeliver(
  user: { id: number; hasPassword: boolean },
  email: string,
  siteName?: string,
) {
  const purpose = user.hasPassword ? "reset" : "claim";
  const token = await issueEmailToken(user.id, purpose);
  const link = `${APP_URL}/${purpose}/${token}`;
  // 站点身份可配（M10.6b）：未取到（调用方读取失败）回退模板默认站名
  await sendMail(
    email,
    purpose === "claim" ? claimMail(link, siteName) : resetPasswordMail(link, siteName),
  );
}

/** 无论结果如何都返回 void：调用方一律跳转到同一个中性视图 */
export async function requestAccountEmail(
  rawEmail: string,
  ip: string | null,
  deps: ForgotDeps,
): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (email === "" || email.length > MAX_EMAIL_LENGTH) return;

  // 有可信 IP：按 IP 限额，在查库之前（对所有输入一视同仁）
  if (
    ip !== null &&
    !rateLimit(`forgot:${ip}`, FORGOT_LIMITS.ip.max, FORGOT_LIMITS.ip.windowMs).allowed
  )
    return;

  const rows = await getWebDb()
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.emailKey, normalizeKey(email)), eq(users.state, "active")))
    .limit(1);
  const user = rows[0];
  if (!user) return;

  const { cooldown, hourly, global } = FORGOT_LIMITS;
  if (
    !rateLimit(`forgot-cooldown:${user.id}`, cooldown.max, cooldown.windowMs).allowed ||
    !rateLimit(`forgot-hour:${user.id}`, hourly.max, hourly.windowMs).allowed
  )
    return;

  // 无可信 IP（直连部署 TRUSTED_PROXY_HOPS=0 时恒如此）：IP 桶不可用，只剩全局兜底桶限制整体发信量。
  // 共享桶可被一个客户端占满、让所有人收不到邮件，所以它**只对真实存在、且通过了账号级额度的请求计数**，放在最后：
  // 随机邮箱烧不掉它（查不到账号就返回了），对同一邮箱反复请求也被账号冷却挡在前面——要占满得知道
  // 一批互不相同的真实注册邮箱。被它丢弃的请求照样返回中性视图，用户稍后重试即可。
  if (ip === null && !rateLimit("forgot-global", global.max, global.windowMs).allowed) return;

  const deliver = deps.deliver ?? defaultDeliver;
  // 站点身份预取（M10.6c 教训）：chrome 有 30s TTL 全局缓存，放请求内是 ~0ms 命中；
  // 放 after() 里会拖慢投递（dev 观测 30s+，首查迟到的连接初始化），E2E 找回轮询一度超时。
  // 对存在/不存在的邮箱一视同仁地读，防枚举时序不受影响。
  const siteName = await getSiteIdentity()
    .then((i) => i.name)
    .catch(() => undefined);
  deps.defer(async () => {
    try {
      await deliver({ id: user.id, hasPassword: user.passwordHash !== null }, email, siteName);
    } catch (e) {
      // 响应早已发出，这里只能记日志；用户重新申请即可
      console.error("[auth] 找回邮件发送失败:", e);
    }
  });
}
