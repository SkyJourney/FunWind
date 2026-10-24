import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimit, rateLimitRefund, resetRateLimiter } from "./ratelimit";

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

describe("rateLimitRefund（先占后退）", () => {
  it("退还后额度恢复；对照：不退还则被挡", () => {
    expect(rateLimit("r", 2, 60_000, 1_000).allowed).toBe(true);
    expect(rateLimit("r", 2, 60_000, 1_100).allowed).toBe(true);
    expect(rateLimit("r", 2, 60_000, 1_200).allowed).toBe(false);
    rateLimitRefund("r");
    expect(rateLimit("r", 2, 60_000, 1_300).allowed).toBe(true);
    expect(rateLimit("r", 2, 60_000, 1_400).allowed).toBe(false);
  });

  it("每占一次退一次：成功登录反复占与退，永远不会被挡", () => {
    for (let i = 0; i < 50; i++) {
      expect(rateLimit("ok", 1, 60_000, 1_000 + i).allowed).toBe(true);
      rateLimitRefund("ok");
    }
  });

  it("不存在的键、已空的桶：静默无副作用；桶退空后被删除（不留空桶）", () => {
    expect(() => rateLimitRefund("never")).not.toThrow();
    rateLimit("one", 3, 60_000, 1_000);
    rateLimitRefund("one");
    rateLimitRefund("one");
    expect(rateLimit("one", 1, 60_000, 1_100).allowed).toBe(true);
  });

  it("不影响其他键", () => {
    rateLimit("a", 1, 60_000, 1_000);
    rateLimit("b", 1, 60_000, 1_000);
    rateLimitRefund("a");
    expect(rateLimit("b", 1, 60_000, 1_100).allowed).toBe(false);
  });
});
