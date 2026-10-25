"use client";

import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { nextGateKey } from "./gate-keys";

/**
 * 编辑器工具栏（M6.3 第 2 步）。每个按钮都是对编辑器命令的薄包装，按钮的按下状态来自编辑器当前选区。
 * 图片不在工具栏：插入图片由外壳提供（上传需要版块上下文，见 editor-shell.tsx）。
 */
export function EditorToolbar({
  editor,
  onInsertGate,
}: {
  editor: Editor;
  onInsertGate?: () => void;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      code: e.isActive("codeBlock"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const chain = () => editor.chain().focus();
  const btn = (
    label: string,
    title: string,
    active: boolean,
    onClick: () => void,
    disabled = false,
  ) => (
    <Button
      key={title}
      type="button"
      size="sm"
      variant={active ? "secondary" : "ghost"}
      aria-label={title}
      aria-pressed={active}
      title={title}
      disabled={disabled}
      onClick={onClick}
      // 移动端触控目标不小于 44px，桌面端保持紧凑
      className="min-h-11 min-w-11 px-2 sm:min-h-9 sm:min-w-9"
    >
      {label}
    </Button>
  );

  return (
    <div role="toolbar" aria-label="编辑工具栏" className="flex flex-wrap gap-1 border-b pb-2">
      {btn("B", "加粗", state.bold, () => chain().toggleBold().run())}
      {btn("I", "斜体", state.italic, () => chain().toggleItalic().run())}
      {btn("S", "删除线", state.strike, () => chain().toggleStrike().run())}
      {btn("•", "无序列表", state.bullet, () => chain().toggleBulletList().run())}
      {btn("1.", "有序列表", state.ordered, () => chain().toggleOrderedList().run())}
      {btn("❝", "引用", state.quote, () => chain().toggleBlockquote().run())}
      {btn("</>", "代码块", state.code, () => chain().toggleCodeBlock().run())}
      {btn("⊞", "插入表格", false, () =>
        chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      )}
      {btn("―", "分隔线", false, () => chain().setHorizontalRule().run())}
      {btn("↵", "换行", false, () => chain().setHardBreak().run())}
      {btn("🔒", "插入门控块", false, () => {
        const key = nextGateKey(editor.getJSON());
        chain()
          .insertContent({
            type: "gate",
            attrs: { key, unlock: "points", price: "10" },
            content: [{ type: "paragraph" }],
          })
          .run();
        onInsertGate?.();
      })}
      {btn("↶", "撤销", false, () => chain().undo().run(), !state.canUndo)}
      {btn("↷", "重做", false, () => chain().redo().run(), !state.canRedo)}
    </div>
  );
}
