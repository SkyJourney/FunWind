import { describe, expect, it } from "vitest";
import { clampPage, pageBounds } from "./paging";

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

  it("pageBounds：统一夹取页码并计算安全 offset", () => {
    expect(pageBounds(101, 3.8, 20)).toEqual({ page: 3, totalPages: 6, offset: 40 });
    expect(pageBounds(101, 999, 20)).toEqual({ page: 6, totalPages: 6, offset: 100 });
    expect(pageBounds(0, Number.NaN, 20)).toEqual({ page: 1, totalPages: 1, offset: 0 });
    expect(pageBounds(Number.POSITIVE_INFINITY, 2, 20)).toEqual({
      page: 1,
      totalPages: 1,
      offset: 0,
    });
    expect(pageBounds(20, Number.POSITIVE_INFINITY, 20)).toEqual({
      page: 1,
      totalPages: 1,
      offset: 0,
    });
    expect(() => pageBounds(1, 1, 0)).toThrow(RangeError);
  });
});
