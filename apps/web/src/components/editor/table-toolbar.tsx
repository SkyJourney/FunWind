"use client";

import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { Button } from "@/components/ui/button";

/**
 * 表格上下文工具条（M10.8 Step 3）：光标在表格内时出现在主工具栏下方，提供增删行列与删除整个表格。
 * 做成固定的一行而不是浮在表格上：不需要计算位置、不被滚动 / 窄屏裁掉，触屏也一样好点。
 *
 * 只提供 Markdown 能表达的操作：不提供合并 / 拆分单元格（GFM 表格没有跨行跨列语法）。
 * 表头行（第一行）不可删除：序列化时第一行就是表头，删掉会让下一行的普通单元格被当作表头，内容语义错位。
 * Tab 跳格、末格 Tab 自动加行由 TableKit 自带。
 */
export function TableToolbar({ editor }: { editor: Editor }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      inTable: e.isActive("table"),
      // 光标所在行是否为第一行（表头）
      inHeaderRow: e.isActive("tableHeader"),
      canDeleteRow: e.can().deleteRow(),
      canDeleteCol: e.can().deleteColumn(),
    }),
  });
  if (!st.inTable) return null;

  const run = (fn: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) =>
    fn(editor.chain().focus()).run();

  const items: {
    label: string;
    text: string;
    disabled?: boolean;
    danger?: boolean;
    act: () => void;
  }[] = [
    {
      label: "在上方插入行",
      text: "上方插行",
      // 表头之上不能再插行（新行会成为表头之上的普通行，序列化错位）
      disabled: st.inHeaderRow,
      act: () => run((c) => c.addRowBefore()),
    },
    { label: "在下方插入行", text: "下方插行", act: () => run((c) => c.addRowAfter()) },
    { label: "在左侧插入列", text: "左侧插列", act: () => run((c) => c.addColumnBefore()) },
    { label: "在右侧插入列", text: "右侧插列", act: () => run((c) => c.addColumnAfter()) },
    {
      label: "删除当前行",
      text: "删除行",
      disabled: st.inHeaderRow || !st.canDeleteRow,
      danger: true,
      act: () => run((c) => c.deleteRow()),
    },
    {
      label: "删除当前列",
      text: "删除列",
      disabled: !st.canDeleteCol,
      danger: true,
      act: () => run((c) => c.deleteColumn()),
    },
    {
      label: "删除整个表格",
      text: "删除表格",
      danger: true,
      act: () => run((c) => c.deleteTable()),
    },
  ];

  return (
    <div
      role="toolbar"
      aria-label="表格工具"
      className="flex [scrollbar-width:none] flex-nowrap items-center gap-1 overflow-x-auto border-t bg-muted/40 px-2 py-1 [&::-webkit-scrollbar]:hidden"
    >
      <span className="shrink-0 pr-1 text-xs text-muted-foreground">表格</span>
      {items.map((it) => (
        <Button
          key={it.label}
          type="button"
          size="sm"
          variant="ghost"
          aria-label={it.label}
          disabled={it.disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={it.act}
          className={`min-h-11 shrink-0 px-2.5 text-xs sm:min-h-8 ${it.danger ? "text-destructive hover:text-destructive" : ""}`}
        >
          {it.text}
        </Button>
      ))}
    </div>
  );
}
