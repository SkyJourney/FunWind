import { describe, expect, it } from "vitest";
import { collectGateKeys, nextGateKey } from "./gate-keys";

describe("nextGateKey：门控 key 在同一帖内唯一", () => {
  it("空文档从 g1 开始", () => {
    expect(nextGateKey({ type: "doc", content: [{ type: "paragraph" }] })).toBe("g1");
    expect(nextGateKey(undefined)).toBe("g1");
  });

  it("跳过已占用的 key，即使中间有空缺", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "gate", attrs: { key: "g1" }, content: [{ type: "paragraph" }] },
        { type: "gate", attrs: { key: "g3" }, content: [] },
      ],
    };
    expect(nextGateKey(doc)).toBe("g2");
  });

  it("嵌套在门控内部的门控也计入占用", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "gate",
          attrs: { key: "g1" },
          content: [{ type: "gate", attrs: { key: "g2" }, content: [] }],
        },
      ],
    };
    expect(collectGateKeys(doc)).toEqual(new Set(["g1", "g2"]));
    expect(nextGateKey(doc)).toBe("g3");
  });

  it("忽略空 key 与非门控节点", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "gate", attrs: { key: "" }, content: [] },
        { type: "paragraph", attrs: { key: "g1" }, content: [] },
      ],
    };
    expect(nextGateKey(doc)).toBe("g1");
  });
});
