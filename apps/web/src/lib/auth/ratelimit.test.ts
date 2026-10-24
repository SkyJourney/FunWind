import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("桶数量超过阈值时低频清理已过期的桶（防内存泄漏）", () => {
    resetRateLimiter();
    const T0 = 1_000_000;
    // 4100 个只有一条过期记录的桶（窗口 1s，记录发生在 T0）
    for (let i = 0; i < 4100; i++) rateLimit(`stale:${i}`, 5, 1000, T0);
    const spy = vi.spyOn(Math, "random").mockReturnValue(0); // 命中 1/256 的清理分支
    try {
      // 窗口已过：这次调用会触发清理，过期桶被删除，新桶正常放行
      expect(rateLimit("fresh", 5, 1000, T0 + 10_000).allowed).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // 过期桶已被清掉：同一个键重新计数，不会受旧记录影响
    expect(rateLimit("stale:0", 1, 1000, T0 + 10_001).allowed).toBe(true);
    expect(rateLimit("stale:0", 1, 1000, T0 + 10_002).allowed).toBe(false);
  });
});
