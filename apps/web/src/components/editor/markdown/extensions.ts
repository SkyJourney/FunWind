import type { marked as DefaultMarked } from "marked";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { HardBreak } from "@tiptap/extension-hard-break";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { Gate } from "./gate";
import { createEditorMarked } from "./marked";

/**
 * 段落内的硬换行：序列化为单个 `\n`（与论坛里既有的写法一致；站点渲染器把它显示为换行）。
 * 官方默认写成两个空格加换行，渲染结果相同，但会改写原文，所以这里替换渲染规则。
 */
const LineBreak = HardBreak.extend({
  renderMarkdown: () => "\n",
});

/**
 * 编辑器的扩展集合（M6.3）。每次调用返回新实例，避免多个编辑器共享可变状态。
 * 图片只做展示与往返（插入与上传在 M6.4）；表格用官方 TableKit。
 */
export function editorExtensions() {
  // Tiptap 把选项类型声明为默认导出 marked 的类型；new Marked() 的解析 API 完全相同，只是少了默认导出上的静态成员。
  // 这里收窄一次并在往返测试里验证运行结果，而不是在调用处散落类型断言。
  const parser = createEditorMarked() as unknown as typeof DefaultMarked;
  return [
    StarterKit.configure({ hardBreak: false }),
    LineBreak,
    Markdown.configure({ marked: parser }),
    TableKit,
    Image,
    Gate,
  ];
}
