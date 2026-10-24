import { beforeEach, describe, expect, it } from "vitest";
import { INVITE_LIMITS, takeInviteAttempt } from "./invite-limit";
import { resetRateLimiter } from "./ratelimit";

beforeEach(() => resetRateLimiter());

describe("邀请码猜测限速", () => {
  it("有可信 IP：同一 IP 连续猜错 10 次后被挡（对照：另一个 IP 不受影响）", () => {
    for (let i = 0; i < INVITE_LIMITS.ip.max; i++)
      expect(takeInviteAttempt("203.0.113.5").allowed).toBe(true);
    expect(takeInviteAttempt("203.0.113.5").allowed).toBe(false);
    expect(takeInviteAttempt("203.0.113.6").allowed).toBe(true);
  });

  it("无可信 IP：退到全局兜底桶，上限更宽松；旧实现这里没有任何限制", () => {
    for (let i = 0; i < INVITE_LIMITS.global.max; i++)
      expect(takeInviteAttempt(null).allowed).toBe(true);
    expect(takeInviteAttempt(null).allowed).toBe(false);
    // 全局桶不影响有可信 IP 的访客
    expect(takeInviteAttempt("198.51.100.1").allowed).toBe(true);
  });

  it("退还：注册成功或失败与邀请码无关时不留计数（对照：不退还则被挡）", () => {
    for (let i = 0; i < 50; i++) {
      const a = takeInviteAttempt("192.0.2.9");
      expect(a.allowed).toBe(true);
      a.refund();
    }
    for (let i = 0; i < INVITE_LIMITS.ip.max; i++) takeInviteAttempt("192.0.2.10"); // 不退还
    expect(takeInviteAttempt("192.0.2.10").allowed).toBe(false);
  });

  it("被拒绝的尝试调用 refund 无副作用：不会把别人占的名额退掉", () => {
    for (let i = 0; i < INVITE_LIMITS.ip.max; i++) takeInviteAttempt("192.0.2.20");
    const denied = takeInviteAttempt("192.0.2.20");
    expect(denied.allowed).toBe(false);
    denied.refund();
    expect(takeInviteAttempt("192.0.2.20").allowed).toBe(false);
  });
});
