import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "./ratelimit";
import { takePreferenceRateLimit } from "./preference-ratelimit";

beforeEach(() => {
  resetRateLimiter();
  vi.spyOn(Date, "now").mockReturnValue(1_000);
});
afterEach(() => vi.restoreAllMocks());

describe("偏好共用账号额度", () => {
  it("每账号 60 次 / 60 秒，超限给出重试秒数；另一个账号独立", () => {
    for (let i = 0; i < 60; i++) expect(takePreferenceRateLimit(42).allowed).toBe(true);
    expect(takePreferenceRateLimit(42)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSec: 60,
    });
    expect(takePreferenceRateLimit(43)).toEqual({ allowed: true, remaining: 59, retryAfterSec: 0 });
  });

  it("等待到窗口结束才恢复额度，重试时间向上取整", () => {
    for (let i = 0; i < 60; i++) takePreferenceRateLimit(42);
    vi.mocked(Date.now).mockReturnValue(60_001);
    expect(takePreferenceRateLimit(42)).toEqual({ allowed: false, remaining: 0, retryAfterSec: 1 });
    vi.mocked(Date.now).mockReturnValue(61_000);
    expect(takePreferenceRateLimit(42)).toEqual({ allowed: true, remaining: 59, retryAfterSec: 0 });
  });
});
