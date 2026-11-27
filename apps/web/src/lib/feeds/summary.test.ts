import { describe, expect, it } from "vitest";
import { summarizeFeedBody } from "./summary";

const GATE = ':::gate{key="locked_01"}\n:::';

describe("订阅摘要", () => {
  it("跳过占位、标题、图像、代码块及空段落，提取首段净化文字", () => {
    const md = [
      GATE,
      "# 标题",
      "![图像说明](https://example.test/image.png)",
      "```js\n代码块\n```",
      "<p>&nbsp;<br></p>",
      '**第一段** &amp; [链接](https://example.test/link)\n带<em>换行</em>\n<span onclick="bad()">正文</span>',
      "第二段",
    ].join("\n\n");
    expect(summarizeFeedBody(md)).toBe("第一段 & 链接 带换行 正文");
  });

  it("忽略整段被净化删除的内容，也保留旧帖直接放在容器里的文字", () => {
    expect(
      summarizeFeedBody(
        '<script>不得输出</script>\n\n<div align="center">旧帖 <b>对齐</b></div>\n\n后续段落',
      ),
    ).toBe("旧帖 对齐");
  });

  it("按文档顺序提取嵌套段落，不跨门控占位拼接", () => {
    expect(summarizeFeedBody(`> 首段\n${GATE}\n次段`)).toBe("首段");
    expect(summarizeFeedBody("- 第一项\n- 第二项")).toBe("第一项");
  });

  it("按 Unicode 码点而非 UTF-16 代码单元截取 120 个字符", () => {
    const text = "🌊".repeat(119) + "𠀀";
    expect(summarizeFeedBody(`${text}末尾`)).toBe(text);
    expect(summarizeFeedBody(`${"甲".repeat(119)} 换行`)).toBe("甲".repeat(119));
  });

  it("判空和截断前去掉 Markdown 原文及 HTML 实体中的非法码点", () => {
    const text = "🌊".repeat(120);
    expect(summarizeFeedBody(`<p>&#1;</p>\n\n<p>&#1;${text}\u0000超出限制</p>`)).toBe(text);
  });

  it("仅有占位、空白和图片时返回空串", () => {
    expect(summarizeFeedBody(`${GATE}\n\n![图](https://example.test/only.png)`)).toBe("");
    expect(summarizeFeedBody(" \n ")).toBe("");
  });
});
