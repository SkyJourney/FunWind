"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect } from "react";
import { editorExtensions } from "./markdown/extensions";
import { EditorToolbar } from "./toolbar";

/**
 * 所见即所得编辑器（M6.3 第 2 步）。内容以 Markdown 载入与导出；每次用户改动（不含程序性的 setContent）
 * 通过 onChange 把当前 Markdown 交给外壳。挂载后的第一次内容由 initialMarkdown 决定（草稿恢复也走这里）。
 *
 * immediatelyRender:false：编辑器只在浏览器中创建，服务端渲染输出一个空容器，避免水合不一致。
 */
export function RichEditor({
  initialMarkdown,
  onChange,
  onReady,
  label,
}: {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  onReady?: (markdown: string) => void;
  label: string;
}) {
  const editor = useEditor({
    extensions: editorExtensions(),
    content: initialMarkdown,
    contentType: "markdown",
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": label,
        role: "textbox",
        "aria-multiline": "true",
        class: "fw-rich-editor min-h-48 px-3 py-2 text-sm leading-relaxed focus:outline-none",
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
  });

  // 编辑器创建完成后把它的 Markdown 报告给外壳（草稿恢复、切换模式都依赖这一次同步）
  useEffect(() => {
    if (editor) onReady?.(editor.getMarkdown());
    // onReady 只在创建时调用一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  if (!editor) return <div className="min-h-48" aria-busy="true" />;
  return (
    <div className="space-y-2">
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}
