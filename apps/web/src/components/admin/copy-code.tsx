"use client";

import { useState } from "react";

/** 一键复制（M9.5 邀请码，M14 恢复命令）：clipboard API，失败回落选中文本提示 */
export function CopyCode({ code, ariaLabel }: { code: string; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // 剪贴板不可用（http/权限）：文案短暂变「复制失败」，3 秒恢复（M16 Step 4 补失败反馈，不再静默）
          setCopied(false);
          setFailed(true);
          setTimeout(() => setFailed(false), 3000);
        }
      }}
      aria-label={ariaLabel ?? `复制邀请码 ${code}`}
      // aria-live：结果文案切换对读屏可感知（成功/失败都有声音出口）
      aria-live="polite"
      className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
    >
      {/* 结果文案节点挂 fw-pop：key 变化重挂即重播「弹一下」；常态渲染纯文本，首屏不弹 */}
      {failed ? (
        <span key="failed" className="fw-pop">
          复制失败
        </span>
      ) : copied ? (
        <span key="copied" className="fw-pop">
          已复制
        </span>
      ) : (
        "复制"
      )}
    </button>
  );
}
