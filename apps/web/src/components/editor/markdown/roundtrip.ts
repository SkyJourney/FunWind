import { Editor } from "@tiptap/core";
import { editorExtensions } from "./extensions";

/**
 * 无头编辑器做一次「载入 → 取回」（M6.3 往返保护的基础）。不挂载 DOM 节点，可在测试与服务端脚本中使用。
 * 返回编辑器序列化出的 Markdown；调用方据此判断原文是否可以安全地进入所见即所得模式。
 */
export function roundtripMarkdown(md: string): string {
  const editor = new Editor({
    extensions: editorExtensions(),
    content: md,
    contentType: "markdown",
  });
  try {
    return editor.getMarkdown();
  } finally {
    editor.destroy();
  }
}
