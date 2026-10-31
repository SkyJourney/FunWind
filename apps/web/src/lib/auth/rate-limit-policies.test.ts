import { beforeEach, describe, expect, it } from "vitest";
import {
  closureCancelIpRateLimit,
  closureConsumeIpRateLimit,
  reportSubmitRateLimit,
} from "./rate-limit-policies";
import { rateLimit, resetRateLimiter } from "./ratelimit";

beforeEach(() => resetRateLimiter());

describe("管理动作频控策略", () => {
  it("举报账号桶在第 11 次请求时拒绝", () => {
    const key = reportSubmitRateLimit.key(42);
    for (let i = 0; i < reportSubmitRateLimit.max; i++) {
      expect(
        rateLimit(key, reportSubmitRateLimit.max, reportSubmitRateLimit.windowMs, 1000 + i).allowed,
      ).toBe(true);
    }
    expect(
      rateLimit(key, reportSubmitRateLimit.max, reportSubmitRateLimit.windowMs, 2000).allowed,
    ).toBe(false);
  });

  it("注销令牌消费 IP 桶第 21 次拒绝；无可信 IP 时跳过", () => {
    expect(closureConsumeIpRateLimit.key(null)).toBeNull();
    const key = closureConsumeIpRateLimit.key("203.0.113.8");
    expect(key).not.toBeNull();
    for (let i = 0; i < closureConsumeIpRateLimit.max; i++) {
      expect(
        rateLimit(key!, closureConsumeIpRateLimit.max, closureConsumeIpRateLimit.windowMs, 3000 + i)
          .allowed,
      ).toBe(true);
    }
    expect(
      rateLimit(key!, closureConsumeIpRateLimit.max, closureConsumeIpRateLimit.windowMs, 4000)
        .allowed,
    ).toBe(false);
  });

  it("注销撤销 IP 桶第 11 次拒绝；无可信 IP 时跳过", () => {
    expect(closureCancelIpRateLimit.key(null)).toBeNull();
    const key = closureCancelIpRateLimit.key("203.0.113.9");
    expect(key).not.toBeNull();
    for (let i = 0; i < closureCancelIpRateLimit.max; i++) {
      expect(
        rateLimit(key!, closureCancelIpRateLimit.max, closureCancelIpRateLimit.windowMs, 5000 + i)
          .allowed,
      ).toBe(true);
    }
    expect(
      rateLimit(key!, closureCancelIpRateLimit.max, closureCancelIpRateLimit.windowMs, 6000)
        .allowed,
    ).toBe(false);
  });
});
