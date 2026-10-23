import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimiter } from "./ratelimit";

beforeEach(() => resetRateLimiter());

describe("rateLimit（滑动窗口）", () => {
  it("窗口内限次", () => {
    expect(rateLimit("k", 3, 60_000, 1_000).allowed).toBe(true);
    expect(rateLimit("k", 3, 60_000, 1_100).allowed).toBe(true);
    expect(rateLimit("k", 3, 60_000, 1_200).allowed).toBe(true);
    const blocked = rateLimit("k", 3, 60_000, 1_300);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("窗口滑出后恢复", () => {
    expect(rateLimit("k", 1, 10_000, 1_000).allowed).toBe(true);
    expect(rateLimit("k", 1, 10_000, 2_000).allowed).toBe(false);
    expect(rateLimit("k", 1, 10_000, 11_001).allowed).toBe(true);
  });

  it("键隔离", () => {
    expect(rateLimit("a", 1, 60_000, 1_000).allowed).toBe(true);
    expect(rateLimit("b", 1, 60_000, 1_000).allowed).toBe(true);
    expect(rateLimit("a", 1, 60_000, 1_100).allowed).toBe(false);
  });
});
