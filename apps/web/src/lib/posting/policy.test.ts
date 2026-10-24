import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_WINDOW_SEC,
  dailyQuotaExceeded,
  initialState,
  intervalViolated,
  type ReviewPolicyValue,
} from "./policy";

describe("initialState 审核分流", () => {
  const policies: ReviewPolicyValue[] = ["none", "threads", "all"];

  it("完整矩阵：版主永远直接可见；普通用户按版块策略", () => {
    const table: Record<ReviewPolicyValue, Record<"thread" | "reply", "visible" | "pending">> = {
      none: { thread: "visible", reply: "visible" },
      threads: { thread: "pending", reply: "visible" },
      all: { thread: "pending", reply: "pending" },
    };
    for (const p of policies)
      for (const k of ["thread", "reply"] as const) {
        expect(initialState(p, k, false), `${p}/${k}`).toBe(table[p][k]);
        expect(initialState(p, k, true), `版主 ${p}/${k}`).toBe("visible");
      }
  });

  it("对照：回帖在 threads 策略下不待审（只审主题）", () => {
    expect(initialState("threads", "reply", false)).toBe("visible");
    expect(initialState("threads", "thread", false)).toBe("pending");
  });
});

describe("intervalViolated 发帖间隔", () => {
  it("间隔为 0（不限）时永远放行", () => {
    expect(intervalViolated(0, 0)).toBe(false);
    expect(intervalViolated(0.5, 0)).toBe(false);
  });

  it("从未发过帖（ageSec=null）放行", () => {
    expect(intervalViolated(null, 5)).toBe(false);
  });

  it("边界：恰好等于间隔放行，少 1 秒违规", () => {
    expect(intervalViolated(5, 5)).toBe(false);
    expect(intervalViolated(4, 5)).toBe(true);
    expect(intervalViolated(0, 5)).toBe(true);
  });
});

describe("dailyQuotaExceeded 每日配额", () => {
  it("0 = 不限", () => {
    expect(dailyQuotaExceeded(10_000, 0)).toBe(false);
  });

  it("边界：已达上限即违规；差一个仍放行", () => {
    expect(dailyQuotaExceeded(1, 2)).toBe(false);
    expect(dailyQuotaExceeded(2, 2)).toBe(true);
    expect(dailyQuotaExceeded(3, 2)).toBe(true);
  });

  it("幂等窗口常量与设计稿一致（60 秒）", () => {
    expect(IDEMPOTENCY_WINDOW_SEC).toBe(60);
  });
});
