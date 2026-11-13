import { describe, expect, it } from "vitest";
import { clampPage, pageBounds, pageLimit, parsePageParam } from "./paging";

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

describe("parsePageParam（审查 A-P2-6：直接锚定，非仅经筛选间接覆盖）", () => {
  it("正整数字符串解析为页码", () => {
    expect(parsePageParam("1")).toBe(1);
    expect(parsePageParam("42")).toBe(42);
  });
  it("非正整数/小数/NaN/空/缺省一律回退 1", () => {
    for (const raw of ["0", "-3", "2.5", "abc", "", undefined, "Infinity"]) {
      expect(parsePageParam(raw)).toBe(1);
    }
  });
});

describe("pageLimit（审查 A-P2-6）", () => {
  it("缺省取 def，越界收束到 [1, max]", () => {
    expect(pageLimit(undefined)).toBe(50);
    expect(pageLimit(undefined, 30)).toBe(30);
    expect(pageLimit(0)).toBe(50); // 0 → 回退 def
    expect(pageLimit(-5)).toBe(1);
    expect(pageLimit(1000)).toBe(200);
    expect(pageLimit(1000, 50, 500)).toBe(500);
  });
  it("小数向零取整后夹取", () => {
    expect(pageLimit(20.9)).toBe(20);
    expect(pageLimit(0.5)).toBe(50); // trunc(0.5)=0 → 回退 def
  });
});
