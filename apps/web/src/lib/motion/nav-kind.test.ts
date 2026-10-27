import { beforeEach, describe, expect, it } from "vitest";
import { consumeNavKind, kindBetween, setNavKind } from "./nav-kind";

describe("nav-kind（路由方向性过渡的方向判定）", () => {
  beforeEach(() => consumeNavKind());

  it("层级更深 → push；更浅 → pop；同层 → fade", () => {
    expect(kindBetween("/", "/t/123")).toBe("push");
    expect(kindBetween("/f/2", "/")).toBe("pop");
    expect(kindBetween("/messages", "/messages/9")).toBe("fade"); // 同段：fade（详情感由 L3 触点扩散承担）
    expect(kindBetween("/u/2", "/u/3")).toBe("fade");
    expect(kindBetween("/messages", "/me")).toBe("push");
    expect(kindBetween("/t/1", "/t/1")).toBe("fade"); // 完全同路径
  });

  it("未列出的路径取中位序（deep 链接之间 → fade 或 pop，不抛错）", () => {
    expect(() => kindBetween("/whatever", "/unknown")).not.toThrow();
    expect(kindBetween("/settings/avatar", "/")).toBe("pop");
  });

  it("set/consume 一次性消费：默认 fade，写入后取一次即复位", () => {
    expect(consumeNavKind()).toBe("fade");
    setNavKind("push");
    expect(consumeNavKind()).toBe("push");
    expect(consumeNavKind()).toBe("fade");
  });
});
