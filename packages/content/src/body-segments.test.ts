import { describe, expect, it } from "vitest";
import { joinBodySegments, splitByGatePlaceholders } from "./body-segments.js";

const P = (k: string) => `:::gate{key="${k}"}\n:::`;

describe("splitByGatePlaceholders", () => {
  it("无门控：整段 md；空串无段", () => {
    expect(splitByGatePlaceholders("你好\n世界")).toEqual([{ kind: "md", text: "你好\n世界" }]);
    expect(splitByGatePlaceholders("")).toEqual([{ kind: "md", text: "" }]);
  });

  it("单个门控切出前后 md 段", () => {
    expect(splitByGatePlaceholders(`前文\n${P("g1")}\n后文`)).toEqual([
      { kind: "md", text: "前文" },
      { kind: "gate", key: "g1" },
      { kind: "md", text: "后文" },
    ]);
  });

  it("门控在开头/结尾、连续门控、门控间空行都保留", () => {
    expect(splitByGatePlaceholders(`${P("a1")}\n正文`)).toEqual([
      { kind: "gate", key: "a1" },
      { kind: "md", text: "正文" },
    ]);
    expect(splitByGatePlaceholders(`正文\n${P("a1")}`)).toEqual([
      { kind: "md", text: "正文" },
      { kind: "gate", key: "a1" },
    ]);
    expect(splitByGatePlaceholders(`${P("g1")}\n${P("g2")}`)).toEqual([
      { kind: "gate", key: "g1" },
      { kind: "gate", key: "g2" },
    ]);
    expect(splitByGatePlaceholders(`${P("g1")}\n\n${P("g2")}`)).toEqual([
      { kind: "gate", key: "g1" },
      { kind: "md", text: "" },
      { kind: "gate", key: "g2" },
    ]);
  });

  it("围栏代码块里的同形文本是用户写的示例，不是门控", () => {
    const body = "示例：\n```\n" + P("g1") + "\n```\n之后";
    expect(splitByGatePlaceholders(body)).toEqual([{ kind: "md", text: body }]);
    const tilde = "~~~\n" + P("g1") + "\n~~~";
    expect(splitByGatePlaceholders(tilde)).toEqual([{ kind: "md", text: tilde }]);
  });

  it("围栏闭合后恢复识别；不同类型的围栏不互相闭合", () => {
    const body = "```\ncode\n```\n" + P("g1");
    expect(splitByGatePlaceholders(body).map((s) => s.kind)).toEqual(["md", "gate"]);
    const mixed = "```\n~~~\n" + P("g1") + "\n```";
    expect(splitByGatePlaceholders(mixed)).toEqual([{ kind: "md", text: mixed }]);
  });

  it("非法 key / 缺闭行 / 缩进的占位不识别，原样留在 md（失败即封闭：不渲染成可交互门控）", () => {
    for (const bad of [
      ':::gate{key="含空格 x"}\n:::',
      ':::gate{key="g1"}\n没有闭行',
      ' :::gate{key="g1"}\n:::',
      ':::gate{key="12345678901234567"}\n:::', // 17 位
    ]) {
      expect(
        splitByGatePlaceholders(bad).every((s) => s.kind === "md"),
        bad,
      ).toBe(true);
    }
  });

  it("往返无损：任意由这些积木随机拼出的正文，split → join 还原原文", () => {
    const bricks = [
      "文字",
      "",
      P("g1"),
      P("a_2"),
      "```",
      "~~~",
      "# 标题",
      "- 项",
      ":::",
      ':::gate{key="x"}',
    ];
    let seed = 20261024;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 300; n++) {
      const len = 1 + Math.floor(rnd() * 12);
      const body = Array.from(
        { length: len },
        () => bricks[Math.floor(rnd() * bricks.length)],
      ).join("\n");
      expect(joinBodySegments(splitByGatePlaceholders(body)), JSON.stringify(body)).toBe(body);
    }
  });
});
