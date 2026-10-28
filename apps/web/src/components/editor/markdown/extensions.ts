import type { marked as DefaultMarked } from "marked";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { HardBreak } from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { CodeBlock } from "./code-block";
import { Gate, type GateConditionOption } from "./gate";
import { createEditorMarked } from "./marked";

/**
 * 段落内的硬换行：序列化为单个 `\n`（与论坛里既有的写法一致；站点渲染器把它显示为换行）。
 * 官方默认写成两个空格加换行，渲染结果相同，但会改写原文，所以这里替换渲染规则。
 */
const LineBreak = HardBreak.extend({
  renderMarkdown: () => "\n",
});

/**
 * 段落：官方的 Markdown 解析会把「只含一张图片的段落」拆成顶层的图片节点（为块级图片设计）。
 * 我们的图片是**行内**节点（表情图要和文字同一行），顶层只能放块，拆出来的文档不合法——
 * 编辑页里点任何地方都会抛 `contentMatchAt on a node with invalid content`，编辑器不再响应
 * （增删改查审计发现：独占一行的图片在旧帖和新帖里都极其常见）。所以这里不拆，图片留在自己的段落里；
 * 其余情形（空段落标记等）沿用官方实现。序列化不变：只含一张图的段落仍写成 `![](url)`。
 */
const SafeParagraph = Paragraph.extend({
  parseMarkdown(token, helpers) {
    const tokens = token.tokens ?? [];
    if (tokens.length === 1 && tokens[0]?.type === "image") {
      return helpers.createNode("paragraph", undefined, helpers.parseInline(tokens));
    }
    // 其余情形沿用官方实现（this.parent 就是被覆盖的那个 parseMarkdown）
    return this.parent!(token, helpers);
  },
});

/**
 * 编辑器的扩展集合（M6.3）。每次调用返回新实例，避免多个编辑器共享可变状态。
 * 图片只做展示与往返（插入与上传在 M6.4）；表格用官方 TableKit。
 */
export function editorExtensions(options: { conditions?: readonly GateConditionOption[] } = {}) {
  // Tiptap 把选项类型声明为默认导出 marked 的类型；new Marked() 的解析 API 完全相同，只是少了默认导出上的静态成员。
  // 这里收窄一次并在往返测试里验证运行结果，而不是在调用处散落类型断言。
  const parser = createEditorMarked() as unknown as typeof DefaultMarked;
  return [
    StarterKit.configure({
      hardBreak: false,
      // 段落换成不拆「只含图片的段落」的版本（见 SafeParagraph）
      paragraph: false,
      // 代码块换成带语言下拉与高亮的版本（见 code-block.ts）
      codeBlock: false,
      // Markdown 没有下划线语法（序列化会写出 ++x++，渲染器不认），所以不提供
      underline: false,
      // 链接只由作者显式设置：不自动识别（自动链接会把紧跟 URL 的中文吞进去，见硬约定 6）、不在粘贴时转换、点击不跳走
      link: { openOnClick: false, autolink: false, linkOnPaste: false, defaultProtocol: "https" },
    }),
    SafeParagraph,
    LineBreak,
    Markdown.configure({ marked: parser }),
    CodeBlock,
    TableKit,
    // 行内图片：表情图（/emoji/…）要和文字同一行；独占一行的图仍是「只含一张图的段落」，Markdown 序列化不变
    Image.configure({ inline: true }),
    options.conditions ? Gate.configure({ conditions: options.conditions }) : Gate,
  ];
}
