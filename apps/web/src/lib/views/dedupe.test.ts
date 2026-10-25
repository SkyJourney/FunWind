import { describe, expect, it } from "vitest";
import { ViewDedupe } from "./dedupe";

const MIN = 60_000;

describe("ViewDedupe", () => {
  it("窗口内同一访客只计一次；窗口过后再计", () => {
    const d = new ViewDedupe(30 * MIN);
    expect(d.admit("1:u:9", 0)).toBe(true);
    expect(d.admit("1:u:9", 10 * MIN)).toBe(false);
    expect(d.admit("1:u:9", 29 * MIN)).toBe(false);
    expect(d.admit("1:u:9", 30 * MIN)).toBe(true);
  });

  it("不同访客、不同主题互不影响", () => {
    const d = new ViewDedupe();
    expect(d.admit("1:u:9", 0)).toBe(true);
    expect(d.admit("1:u:10", 0)).toBe(true);
    expect(d.admit("2:u:9", 0)).toBe(true);
  });

  it("超过上限时淘汰过期与最早的键，内存有界", () => {
    const d = new ViewDedupe(30 * MIN, 3);
    for (let i = 0; i < 10; i++) d.admit(`k${i}`, i);
    expect(d.size).toBeLessThanOrEqual(3);
    // 最近的键仍在窗口内，应当被去重
    expect(d.admit("k9", 10)).toBe(false);
  });
});

describe("ViewDedupe：满载后的淘汰", () => {
  it("超限时一次淘汰到上限的九成，之后的准入不会每次都整表清理", () => {
    const d = new ViewDedupe(60_000, 10);
    for (let i = 0; i < 11; i++) d.admit(`k${i}`, 1_000);
    // 第 11 个键触发淘汰：从 11 降到 9（上限 10 的九成）
    expect(d.size).toBe(9);
    // 之后再插入一个键（10 个）不会触发清理
    d.admit("k11", 1_000);
    expect(d.size).toBe(10);
  });
});
