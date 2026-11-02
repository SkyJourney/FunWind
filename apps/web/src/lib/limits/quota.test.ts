import { describe, expect, it } from "vitest";
import { dailyQuotaExceeded } from "./quota";

describe("dailyQuotaExceeded 每日配额", () => {
  it("0 = 不限", () => {
    expect(dailyQuotaExceeded(10_000, 0)).toBe(false);
  });

  it("边界：已达上限即违规；差一个仍放行", () => {
    expect(dailyQuotaExceeded(1, 2)).toBe(false);
    expect(dailyQuotaExceeded(2, 2)).toBe(true);
    expect(dailyQuotaExceeded(3, 2)).toBe(true);
  });
});
