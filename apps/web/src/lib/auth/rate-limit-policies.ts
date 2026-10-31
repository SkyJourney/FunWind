const HOUR_MS = 60 * 60_000;

/** 举报按账号限额；注销验证和撤销只在可信 IP 可用时启用 IP 桶。 */
export const reportSubmitRateLimit = {
  key: (userId: number) => `report:${userId}`,
  max: 10,
  windowMs: HOUR_MS,
} as const;

export const closureConsumeIpRateLimit = {
  key: (ip: string | null) => (ip === null ? null : `closure-consume-ip:${ip}`),
  max: 20,
  windowMs: HOUR_MS,
} as const;

export const closureCancelIpRateLimit = {
  key: (ip: string | null) => (ip === null ? null : `closure-cancel-ip:${ip}`),
  max: 10,
  windowMs: HOUR_MS,
} as const;
