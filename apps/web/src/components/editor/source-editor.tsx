"use client";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { findImageRanges } from "./inline-images";
import type { InsertApi } from "./insert-api";

/**
 * Markdown 源码模式（M6.3 第 2 步）：CodeMirror 6。由外壳通过 next/dynamic 按需加载，只在切换到源码时下载。
 * 初始文本只在挂载时读取；之后的改动通过 onChange 报告。
 */
export default function SourceEditor({
  initialMarkdown,
  onChange,
  onApi,
  label,
}: {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  /** 视图创建后交出插入能力；卸载时传 null */
  onApi?: (api: InsertApi | null) => void;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  // 回调走 ref：重新渲染不会重建编辑器
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const onApiRef = useRef(onApi);
  useEffect(() => {
    onApiRef.current = onApi;
  }, [onApi]);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialMarkdown,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": label,
            role: "textbox",
            "aria-multiline": "true",
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    // 创建后立即报告一次，外壳据此同步隐藏字段（草稿恢复时文本可能与服务端给出的不同）
    onChangeRef.current(view.state.doc.toString());
    onApiRef.current?.({
      insertImage(url: string, alt?: string) {
        const { from, to } = view.state.selection.main;
        // alt 里的 Markdown 结构字符要转义（表达式 alt 不允许未转义的 ] 与 [）
        const safeAlt = (alt ?? "").replace(/([\\\[\]])/g, "\\$1");
        const text = `![${safeAlt}](${url})`;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        view.focus();
      },
      removeImage(url: string) {
        const changes = findImageRanges(view.state.doc.toString(), url);
        if (changes.length > 0) view.dispatch({ changes });
      },
      isComposing: () => view.composing,
    });
    return () => {
      onApiRef.current?.(null);
      view.destroy();
    };
    // 只在挂载时创建一次；initialMarkdown 只作为初始值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className="fw-source-editor min-h-48 bg-transparent text-sm" />;
}
