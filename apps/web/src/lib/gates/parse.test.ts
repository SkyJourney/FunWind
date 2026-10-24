import { describe, expect, it } from "vitest";
import { parseConditions } from "./parse";

describe("parseConditions（conditions JSON 列的容错解析）", () => {
  it("数组原样接受，只保留带字符串 type 的对象", () => {
    expect(parseConditions([{ type: "points", price: 5 }, { type: "reply" }])).toEqual([
      { type: "points", price: 5 },
      { type: "reply" },
    ]);
    expect(parseConditions([{ type: 1 }, null, "x", 3, { price: 5 }, { type: "ok" }])).toEqual([
      { type: "ok" },
    ]);
  });

  it("字符串形态的 JSON 会被解析；非法 JSON / 非数组 / 其他类型一律得到空数组（空条件在判定里封闭）", () => {
    expect(parseConditions('[{"type":"reply"}]')).toEqual([{ type: "reply" }]);
    for (const bad of ["{not json", '{"type":"reply"}', "42", null, undefined, 7, {}]) {
      expect(parseConditions(bad), String(bad)).toEqual([]);
    }
  });
});
