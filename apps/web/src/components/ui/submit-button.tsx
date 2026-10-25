"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

/**
 * 表单提交按钮（防双击）：提交进行中禁用。
 * 管理动作（积分调整/授予等）用随机幂等键，双击就是两笔——必须在 UI 层挡住重复提交。
 * 必须放在 <form> 内部（useFormStatus 读取最近的 form 上下文）。
 */
export function SubmitButton({
  children,
  className,
  pendingText = "提交中…",
}: {
  children: ReactNode;
  className?: string;
  pendingText?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? pendingText : children}
    </button>
  );
}
