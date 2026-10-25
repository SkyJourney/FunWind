// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SOURCE_ONLY_REASON, renderEquivalent, richEditReason } from "./roundtrip-check";

describe("往返保护：渲染等价", () => {
  it("普通段落、删除线、换行：可以所见即所得编辑", () => {
    expect(richEditReason("**粗** ~~删~~\n第二行")).toBeNull();
  });

  it("原始 HTML（<sup>）：渲染结果会变，只能源码编辑", () => {
    expect(richEditReason("正文<sup>[1]</sup>结束")).toBe(SOURCE_ONLY_REASON);
  });

  it("门控语法有误（拆分报错）：视为不等价，只能源码编辑", () => {
    expect(richEditReason(':::gate{key="x" unlock="unknown"}\n内容\n:::')).toBe(SOURCE_ONLY_REASON);
  });

  it("门控的隐藏正文不同：不等价", () => {
    const a = ':::gate{key="g1" unlock="points" price="10"}\n甲\n:::';
    const b = ':::gate{key="g1" unlock="points" price="10"}\n乙\n:::';
    expect(renderEquivalent(a, b)).toBe(false);
    expect(renderEquivalent(a, a)).toBe(true);
  });
});
