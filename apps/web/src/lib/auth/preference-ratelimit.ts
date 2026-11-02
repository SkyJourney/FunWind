import { rateLimit, type RateLimitResult } from "./ratelimit";

/** 三类偏好的 PATCH 与 Server Action 共用账号额度，避免换入口或偏好种类绕过每分钟 60 次的上限。 */
export function takePreferenceRateLimit(userId: number): RateLimitResult {
  return rateLimit(`settings-preferences:user:${userId}`, 60, 60_000);
}
