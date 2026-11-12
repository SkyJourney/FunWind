"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";

/**
 * 密码输入（M10.6d）：shadcn Input + 可见性切换（auth 线稿定稿项）。
 * 切换按钮 type=button，不触发表单提交。
 */
export function PasswordField({
  name,
  placeholder,
  required = true,
  autoComplete,
  minLength,
}: {
  name: string;
  placeholder?: string;
  required?: boolean;
  autoComplete?: string;
  minLength?: number;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        name={name}
        type={show ? "text" : "password"}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        minLength={minLength}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "隐藏密码" : "显示密码"}
        aria-pressed={show}
        // 视觉保持 32px（输入框只有 36px 高，放大会显得挤）；伪元素把点击热区外扩到 40px，不影响布局
        className="absolute top-1/2 right-1.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors before:absolute before:-inset-1 before:content-[''] hover:bg-accent hover:text-foreground"
      >
        {/* 显隐切换淡入（M16 Step 4）：key={show} 让每次切换重挂图标、fw-fade-in 重播一次；reduce 下由 globals.css 归零 */}
        {show ? (
          <EyeOff key="eye-off" className="fw-fade-in size-4" aria-hidden />
        ) : (
          <Eye key="eye" className="fw-fade-in size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
