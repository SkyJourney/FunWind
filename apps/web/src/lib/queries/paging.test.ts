import { describe, expect, it } from "vitest";
import { clampPage } from "./paging";

describe("clampPage", () => {
  it("正常整数原样返回；越界收束到两端", () => {
    expect(clampPage(1, 3)).toBe(1);
    expect(clampPage(3, 3)).toBe(3);
    expect(clampPage(4, 3)).toBe(3);
    expect(clampPage(-5, 3)).toBe(1);
    expect(clampPage(0, 3)).toBe(1);
  });

  it("小数向零取整：2.5 不会变成 OFFSET 37.5（审查 P2-1）", () => {
    expect(clampPage(2.5, 3)).toBe(2);
    expect(clampPage(2.999, 3)).toBe(2);
    expect(clampPage(0.5, 3)).toBe(1);
    expect(Number.isInteger(clampPage(1.0000001, 9))).toBe(true);
  });

  it("NaN → 第 1 页；±Infinity 与超大值收束到两端；totalPages 异常时至少 1 页", () => {
    expect(clampPage(Number.NaN, 3)).toBe(1);
    expect(clampPage(Number.POSITIVE_INFINITY, 3)).toBe(3);
    expect(clampPage(Number.NEGATIVE_INFINITY, 3)).toBe(1);
    expect(clampPage(1e300, 3)).toBe(3);
    expect(clampPage(5, 0)).toBe(1);
  });
});
