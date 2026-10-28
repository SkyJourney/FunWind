"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect } from "react";
import { editorExtensions } from "./markdown/extensions";
import type { InsertApi } from "./insert-api";
import { EditorToolbar } from "./toolbar";
import { TableToolbar } from "./table-toolbar";

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
  onApi,
  label,
  onUploadImage,
  imageDisabled,
}: {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  onReady?: (markdown: string) => void;
  /** 编辑器创建后交出插入能力；卸载时传 null */
  onApi?: (api: InsertApi | null) => void;
  label: string;
  /** 提供时工具栏出现「上传图片」按钮（上传由外壳负责：需要版块上下文） */
  onUploadImage?: () => void;
  imageDisabled?: boolean;
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
        // content-md：与帖子正文同一套排版（标题 / 列表 / 引用 / 代码 / 表格），所见即所得才名副其实
        class:
          "fw-rich-editor content-md min-h-48 px-3 py-2 text-sm leading-relaxed focus:outline-none",
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
  });

  // 插入能力：图片节点由 Image 扩展渲染，序列化为 ![](url)
  useEffect(() => {
    if (!editor) return;
    onApi?.({
      insertImage: (url: string) => {
        editor.chain().focus().setImage({ src: url, alt: "" }).run();
      },
      removeImage: (url: string) => {
        // 从后往前删，位置不会因前面的删除而错位
        const hits: { pos: number; size: number }[] = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === "image" && node.attrs.src === url)
            hits.push({ pos, size: node.nodeSize });
        });
        if (hits.length === 0) return;
        const tr = editor.state.tr;
        for (const h of hits.reverse()) tr.delete(h.pos, h.pos + h.size);
        editor.view.dispatch(tr);
      },
      isComposing: () => editor.view.composing,
    });
    return () => onApi?.(null);
    // onApi 由外壳以 ref 的方式传入，只随编辑器实例变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // 编辑器创建完成后把它的 Markdown 报告给外壳（草稿恢复、切换模式都依赖这一次同步）
  useEffect(() => {
    if (editor) onReady?.(editor.getMarkdown());
    // onReady 只在创建时调用一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  if (!editor) return <div className="min-h-48 rounded-lg border border-input" aria-busy="true" />;
  return (
    // 外框：边框 + 聚焦环；工具栏吸附在站点顶栏下方（长文时不用滚回顶部），移动端顶栏 h-16、桌面 h-14
    <div className="fw-editor rounded-lg border border-input bg-card shadow-1 focus-within:ring-2 focus-within:ring-ring/50">
      <div className="sticky top-16 z-10 rounded-t-lg border-b bg-card/95 backdrop-blur md:top-14">
        <EditorToolbar
          editor={editor}
          onUploadImage={onUploadImage}
          imageDisabled={imageDisabled}
        />
        <TableToolbar editor={editor} />
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
