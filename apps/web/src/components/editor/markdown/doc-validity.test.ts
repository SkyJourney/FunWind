// @vitest-environment jsdom
/**
 * 文档有效性（增删改查审计发现的严重缺陷）：任何 Markdown 载入编辑器后，ProseMirror 文档必须符合 schema。
 * 往返测试只比较 Markdown 文本，文档结构不合法时文本照样「逐字相同」——Step 7 把图片改成行内后，
 * 独占一行的图片被拆成顶层的行内节点，编辑页里点任何地方都抛 `contentMatchAt on a node with invalid content`、
 * 编辑器不再响应，而当时所有测试都是绿的。所以这里对一组有代表性的 Markdown 逐个断言 `doc.check()`，
 * 并确认序列化回去与原文一致。
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { editorExtensions } from "./extensions";

const URL1 = `/files/e4/ea/${"e4ea".repeat(16)}.png`;
const URL2 = `/files/ab/cd/${"abcd".repeat(16)}.jpg`;

const CASES: [string, string][] = [
  ["独占一行的图", `![](${URL1})`],
  ["文字后独占一行的图", `前文\n\n![](${URL1})\n\n后文`],
  ["两张图各占一行", `![](${URL1})\n\n![](${URL2})`],
  ["带 alt 的图", `![说明](${URL1})`],
  ["文字夹图", `前 ![](${URL1}) 后`],
  ["行末的图", `文字 ![](${URL1})`],
  ["行首的图", `![](${URL1}) 文字`],
  ["表情图（行内）", "你好 ![表情](/emoji/134.gif) 再见"],
  ["连写的两个表情图", "![表情](/emoji/134.gif)![表情](/emoji/135.gif)"],
  ["引用里的图", `> ![](${URL1})`],
  ["列表里的图", `- ![](${URL1})`],
  ["锁定内容里的图", `:::gate{key="g1" unlock="reply"}\n![](${URL1})\n:::`],
  ["表格", "| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |"],
  ["锁定内容", ':::gate{key="g1" unlock="points" price="10"}\n隐藏\n:::'],
  ["代码块（带语言）", "```javascript\nconst a = 1;\n```"],
  ["分隔线夹在段落间", "上\n\n---\n\n下"],
  ["标题", "## 标题\n\n正文"],
  ["行内格式", "**粗** *斜* ~~删~~ `码` [链](https://a.cn)"],
  ["有序与无序列表", "- 甲\n- 乙\n\n1. 一\n2. 二"],
  ["嵌套列表", "- 甲\n  - 乙"],
  ["引用", "> 引文\n\n后文"],
  ["Unicode 表情", "好 😀 的 👍🏽"],
];

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

describe("载入后的文档符合 schema（doc.check）", () => {
  it.each(CASES)("%s", (_name, md) => {
    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: editorExtensions(),
      content: md,
      contentType: "markdown",
    });
    // 不合法会抛 RangeError: Invalid content for node ...
    expect(() => editor!.state.doc.check()).not.toThrow();
    // 并且序列化回去与原文一致（独占一行的图仍写成 ![](url)，不多不少）
    // 表格序列化时各列会补空格对齐（渲染等价），其余用例逐字比较
    const norm = (t: string) => (md.startsWith("|") ? t.replace(/[ \t]+/g, " ") : t).trim();
    expect(norm(editor.getMarkdown())).toBe(norm(md));
  });
});

describe("载入后继续编辑不会抛异常（点击 / 输入 / 删除都经过事务）", () => {
  it("只含一张图的帖子：在图片后输入文字、再删除图片", () => {
    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: editorExtensions(),
      content: `![](${URL1})`,
      contentType: "markdown",
    });
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe("image");
    editor.commands.focus("end");
    editor.commands.insertContent("后续文字");
    expect(editor.getMarkdown()).toContain("后续文字");
    expect(() => editor!.state.doc.check()).not.toThrow();
    editor.commands.undo();
    editor.commands.setNodeSelection(1);
    editor.commands.deleteSelection();
    expect(editor.getMarkdown()).not.toContain("/files/");
    expect(() => editor!.state.doc.check()).not.toThrow();
  });
});
