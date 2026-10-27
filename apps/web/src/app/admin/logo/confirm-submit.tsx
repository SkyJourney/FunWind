"use client";

import { Trash2 } from "lucide-react";
import { SubmitButton } from "@/components/ui/submit-button";

/** 带确认的提交按钮（移除等不可逆管理操作；确认文案由浏览器原生 confirm 承担）。 */
export function ConfirmSubmit({
  label,
  message,
  destructive = true,
}: {
  label: string;
  message: string;
  destructive?: boolean;
}) {
  return (
    <SubmitButton
      className={`w-full rounded-md border px-2.5 py-1 text-xs hover:bg-accent ${
        destructive ? "text-destructive" : ""
      }`}
      pendingText="处理中…"
    >
      <span
        onClick={(e) => {
          if (!window.confirm(message)) e.preventDefault();
        }}
        className="inline-flex items-center gap-1"
      >
        <Trash2 className="inline size-3" aria-hidden />
        {label}
      </span>
    </SubmitButton>
  );
}
