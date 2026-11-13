import { describe, expect, it } from "vitest";
import { parseRumFilter, percentile } from "./queries";

describe("parseRumFilter（纯函数，非法值回退）", () => {
  it("合法 kind/name 保留，枚举外忽略", () => {
    expect(parseRumFilter({ kind: "vital", name: "LCP" })).toMatchObject({
      kind: "vital",
      name: "LCP",
    });
    expect(parseRumFilter({ kind: "bogus", name: "HACK" })).toEqual({ page: 1 });
  });

  it("error 类型名合法", () => {
    expect(parseRumFilter({ kind: "error", name: "js-error" })).toMatchObject({
      kind: "error",
      name: "js-error",
    });
  });

  it("route 去空白并截断 200", () => {
    expect(parseRumFilter({ route: "  /t/  " }).route).toBe("/t/");
    expect(parseRumFilter({ route: "a".repeat(300) }).route).toHaveLength(200);
    expect(parseRumFilter({ route: "   " }).route).toBeUndefined();
  });

  it("页码非正整数回退 1", () => {
    expect(parseRumFilter({ page: "3" }).page).toBe(3);
    for (const page of ["0", "-2", "abc", "1.5", ""]) {
      expect(parseRumFilter({ page }).page).toBe(1);
    }
  });
});

describe("percentile（nearest-rank，与 perf-posting 同算法）", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  it("p75/p50/p100 正确", () => {
    expect(percentile(hundred, 75)).toBe(75);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 100)).toBe(100);
  });
  it("p0 与单元素不越界", () => {
    expect(percentile(hundred, 0)).toBe(1);
    expect(percentile([42], 75)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
  });
  it("小样本 p75 取到上界元素", () => {
    expect(percentile([10, 20, 30, 40], 75)).toBe(30);
  });
});
