import { rateLimit, rateLimitRefund } from "./ratelimit";

/**
 * 邀请码猜测限速（M5.6 S3）。邀请制下，邀请码是注册的唯一门槛，必须单独限速：
 * 通用的注册 IP 桶（5 次 / 小时）一旦放宽，或取不到可信 IP（此时 IP 桶不参与，见 client-ip.ts），邀请制下就没有任何限制。
 * 做法与登录一致——「先占后退」：注册前占一个名额，注册成功、或失败原因与邀请码无关（用户名被占用等）时退还，
 * 只有「邀请码无效 / 已用 / 过期」会留下计数。
 * 有可信 IP 按 IP 限额；取不到时（直连部署 TRUSTED_PROXY_HOPS=0 时恒如此）用全局兜底桶。
 *
 * 已知取舍（自动安全审查指出，M5.6 S4 记录）：全局桶可被一个客户端用约 100 次错误邀请码占满，让这一小时内所有人的
 * 邀请注册都被拒（返回「邀请码尝试过于频繁，请稍后再试」，不丢数据）。这里**不得**改成放开：邀请码的熵没有保证
 * （仓库里没有生成逻辑，种子里甚至是人工取的字符串），无限猜测等于邀请制形同虚设；而邀请注册本身低频，被占满的代价只是等一小时。
 * 想消除这个取舍，生产部署必须设置 TRUSTED_PROXY_HOPS ≥ 1 让 IP 桶生效（见 docs/AUTHZ.md 的客户端 IP 一节），全局桶只是兜底。
 */

export const INVITE_LIMITS = {
  ip: { max: 10, windowMs: 60 * 60_000 },
  global: { max: 100, windowMs: 60 * 60_000 },
} as const;

export interface InviteAttempt {
  allowed: boolean;
  /** 退还本次名额（注册成功，或失败与邀请码无关时调用）；未被允许时调用无副作用 */
  refund: () => void;
}

export function takeInviteAttempt(ip: string | null): InviteAttempt {
  const key = ip !== null ? `register-invite:${ip}` : "register-invite-global";
  const lim = ip !== null ? INVITE_LIMITS.ip : INVITE_LIMITS.global;
  const allowed = rateLimit(key, lim.max, lim.windowMs).allowed;
  return { allowed, refund: () => (allowed ? rateLimitRefund(key) : undefined) };
}
