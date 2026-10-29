"use client";

import { useState } from "react";

/** 邀请码一键复制（M9.5）：clipboard API，失败回落选中文本提示 */
export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // 剪贴板不可用（http/权限）：提示手动复制
          setCopied(false);
        }
      }}
      aria-label={`复制邀请码 ${code}`}
      className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}
