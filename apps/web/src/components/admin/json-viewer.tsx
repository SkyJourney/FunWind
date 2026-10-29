"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/** 审计日志 JSON 详情弹层（M9.5）：格式化展示 + 复制；服务端组件行内放触发按钮不可行，整个组件客户端化 */
export function JsonViewerButton({ label, json }: { label: string; json: unknown }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(json, null, 2);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border px-1.5 py-0.5 text-xs text-primary hover:bg-accent"
      >
        {label}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>详情 JSON</DialogTitle>
            <DialogDescription className="sr-only">该条日志的完整 JSON 数据</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[50vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
            {text}
          </pre>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                setCopied(false);
              }
            }}
            className="self-start rounded-lg border px-3 py-1.5 text-sm hover:bg-accent"
          >
            {copied ? "已复制" : "复制 JSON"}
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
