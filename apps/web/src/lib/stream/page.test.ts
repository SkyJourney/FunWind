import { describe, expect, it } from "vitest";
import { MAX_STREAM_PAGE, parsePositiveInt, parseStreamPage, withPageParam } from "./page";

describe("parseStreamPage", () => {
  it("缺省 / 非数字 / 0 / 负数 → 第 1 页", () => {
    for (const raw of [null, undefined, "", "abc", "0", "-3", "NaN"]) {
      expect(parseStreamPage(raw)).toBe(1);
    }
  });

  it("小数向零取整（2.9 → 2），不会产生 OFFSET 小数", () => {
    expect(parseStreamPage("2.9")).toBe(2);
  });

  it("超大页码与 Infinity 收束到上限，避免极深偏移", () => {
    expect(parseStreamPage("999999")).toBe(MAX_STREAM_PAGE);
    expect(parseStreamPage("Infinity")).toBe(MAX_STREAM_PAGE);
  });
});

describe("parsePositiveInt", () => {
  it("正整数通过，其余为 undefined", () => {
    expect(parsePositiveInt("12")).toBe(12);
    for (const raw of [null, undefined, "", "0", "-1", "1.5", "x"]) {
      expect(parsePositiveInt(raw)).toBeUndefined();
    }
  });
});

describe("withPageParam", () => {
  it("基础路径无查询串用 ?，已有查询串用 &", () => {
    expect(withPageParam("/api/stream/home", 2)).toBe("/api/stream/home?page=2");
    expect(withPageParam("/api/stream/home?sort=new", 3)).toBe("/api/stream/home?sort=new&page=3");
  });
});
