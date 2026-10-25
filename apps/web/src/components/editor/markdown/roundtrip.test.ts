// @vitest-environment jsdom
/**
 * 编辑器 Markdown 往返（M6.3 第 1 步）：纯语法层的固定用例。
 * 每条用例都是「编辑器载入 → 不改 → 取回」后必须逐字相同，或在注释里写明的已知差异（渲染等价但文本不同）。
 * 语料只用合成样例，不含任何真实帖子内容。
 */
import { describe, expect, it } from "vitest";
import { roundtripMarkdown } from "./roundtrip";

describe("往返：逐字保持的语法", () => {
  it.each([
    ["删除线（双波浪线）", "**粗** ~~删~~ 文本"],
    ["段落内的单个换行（硬换行）", "第一行\n第二行"],
    ["换行后接加粗", "**粗**\n下一行"],
    ["段落之间的空行", "段落一\n\n段落二"],
    ["无序列表", "- 列表\n- 列表二"],
    ["行内代码后换行", "x\n`code`\ny"],
    ["标题", "# 标题\n\n正文"],
  ])("%s", (_name, md) => {
    expect(roundtripMarkdown(md)).toBe(md);
  });
});

describe("往返：单个波浪线不是删除线", () => {
  it("中文语气词 ~x~ 保留为普通文字（序列化时转义，渲染结果不变）", () => {
    const out = roundtripMarkdown("握爪~我也是~好在");
    // 不能变成删除线：输出里不得出现 ~~ 删除标记
    expect(out).not.toContain("~~");
    // 去掉转义后与原文一致
    expect(out.replace(/\\~/g, "~")).toBe("握爪~我也是~好在");
  });
});

describe("往返：表格（渲染等价，文本会按列对齐）", () => {
  it("表格的单元格内容不变", () => {
    const out = roundtripMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toMatch(/\|\s*a\s*\|\s*b\s*\|/);
    expect(out).toMatch(/\|\s*1\s*\|\s*2\s*\|/);
  });
});

describe("往返：门控块", () => {
  it("属性与隐藏正文保留，结尾的空行不影响语义", () => {
    const md = ':::gate{key="g1" unlock="points" price="10"}\n隐藏正文\n:::';
    expect(roundtripMarkdown(md).trimEnd()).toBe(md);
  });

  it("回复可见的门控（无 price）不写出价格", () => {
    const md = ':::gate{key="g2" unlock="reply"}\n回复后可见\n:::';
    expect(roundtripMarkdown(md).trimEnd()).toBe(md);
  });

  it("外层 4 个冒号包住内层 3 个冒号的指令：外层围栏保持 4 个冒号", () => {
    const md = '::::gate{key="g3" unlock="points" price="5"}\n前段\n\n:::note\n内层\n:::\n::::';
    const out = roundtripMarkdown(md).trimEnd();
    expect(out.startsWith("::::gate{")).toBe(true);
    expect(out.endsWith("::::")).toBe(true);
    expect(out).toContain(":::note");
  });
});
