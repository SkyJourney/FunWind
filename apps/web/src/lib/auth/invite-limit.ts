import { rateLimit, rateLimitRefund } from "./ratelimit";

/**
 * 邀请码猜测限速（M5.6 S3）。邀请制下，邀请码是注册的唯一门槛，必须单独限速：
 * 通用的注册 IP 桶（5 次 / 小时）一旦放宽，或取不到可信 IP（此时 IP 桶不参与，见 client-ip.ts），邀请制下就没有任何限制。
 * 做法与登录一致——「先占后退」：注册前占一个名额，注册成功、或失败原因与邀请码无关（用户名被占用等）时退还，
 * 只有「邀请码无效 / 已用 / 过期」会留下计数。
 * 有可信 IP 按 IP 限额；取不到时用全局兜底桶（更宽松，只防批量穷举，不能因此让所有人的注册互相挤占）。
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
