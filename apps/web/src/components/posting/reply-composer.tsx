"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/**
 * 快速回复的草稿层（M6.2）。表单是原生 `<form action>`，直接提交 Server Action；这里只管未发送的草稿。
 * 草稿规则与发主题一致：键含用户与主题号（换主题不串草稿）；只存在本标签页的 sessionStorage；
 * 失败跳回（带 `restore`）时恢复，否则清空；读写均包在 try/catch 里。
 */
interface Props {
  action: (formData: FormData) => Promise<void>;
  threadId: number;
  /** 表单所在的回帖页，失败后原样跳回 */
  page: number;
  draftKey: string;
  restore: boolean;
  bodyMax: number;
}

export function ReplyComposer({ action, threadId, page, draftKey, restore, bodyMax }: Props) {
  const sourceRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      if (!restore) {
        window.sessionStorage.removeItem(draftKey);
        return;
      }
      const raw = window.sessionStorage.getItem(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw) as { source?: unknown };
      if (sourceRef.current && typeof d.source === "string") sourceRef.current.value = d.source;
    } catch {
      // 存储不可用：不恢复，表单照常使用
    }
  }, [draftKey, restore]);

  const saveDraft = () => {
    try {
      window.sessionStorage.setItem(
        draftKey,
        JSON.stringify({ source: sourceRef.current?.value ?? "" }),
      );
    } catch {
      // 写入失败只是少了草稿
    }
  };

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="page" value={page} />

      <label htmlFor="reply-source" className="sr-only">
        回复内容
      </label>
      <textarea
        id="reply-source"
        name="source"
        ref={sourceRef}
        onInput={saveDraft}
        rows={6}
        placeholder="写下你的回复……"
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">最多 {bodyMax} 字</p>
        <Button type="submit">发表回复</Button>
      </div>
    </form>
  );
}
