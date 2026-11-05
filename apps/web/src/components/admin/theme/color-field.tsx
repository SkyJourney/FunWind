"use client";

import { useId, useState } from "react";
import { blockEnterSubmit } from "@/components/admin/theme/enter-guard";
import { Input } from "@/components/ui/input";
import { hexColorSchema } from "@/lib/theme/color";
import { cn } from "@/lib/utils";

const isHex = (text: string) => hexColorSchema.safeParse(text).success;

/**
 * 颜色输入（M11.6 Step 3a）：hex 文本框 + 色块，替换主题编辑器里原生的 `type="color"`
 * ——后者无法精确输入，也看不到当前值。
 *
 * 契约：`onChange` 只会收到合法的小写 `#rrggbb`。文本框里正在输入的内容（半截的、写错的）只留在本组件内，
 * 不会进入编辑器的草稿，也就不会让预览因为 schema 校验失败而整体回退到空定义。输入不合法时显示错误，
 * 并说明当前仍然生效的值——保存时用的是那个值，不是框里的文字。
 *
 * 色块只是鼠标取色的便捷入口：文本框本身就是完整的控件，所以色块 aria-hidden 且不可聚焦，
 * 读屏与键盘用户不会遇到两个重复的控件。它在 DOM 里排在文本框之后（外层 <label> 才会指向文本框），
 * 用 order 把它显示在左边。
 *
 * 切换编辑对象时（同一个实例要显示另一个对象的颜色），调用方应换 key，
 * 否则上一个对象里没写完的文本会留在框里。
 */
export function ColorField({
  label,
  value,
  onChange,
  testId,
  className,
}: {
  /** 文本框的可访问名称；旁边有可见文字时，应包含该文字 */
  label: string;
  /** 当前生效的值，须为合法的 #RRGGBB */
  value: string;
  onChange: (hex: string) => void;
  testId?: string;
  className?: string;
}) {
  const errorId = useId();
  // draft 只在用户输入了不合法文本时非空；合法输入立即提交并清掉 draft，之后框里显示父级传回的值
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null;

  const commit = (hex: string) => {
    setDraft(null);
    onChange(hex);
  };

  return (
    <span className={cn("inline-flex min-w-0 flex-col gap-1", className)}>
      <span className="inline-flex items-center gap-1.5">
        <Input
          type="text"
          data-testid={testId}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          value={draft ?? value}
          onChange={(event) => {
            const next = event.target.value;
            const candidate = next.trim();
            if (isHex(candidate)) commit(candidate.toLowerCase());
            else setDraft(next);
          }}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onKeyDown={blockEnterSubmit}
          className="h-8 w-24 px-2 font-mono text-xs md:text-xs"
        />
        <input
          type="color"
          aria-hidden="true"
          tabIndex={-1}
          value={value}
          onChange={(event) => commit(event.target.value)}
          className="order-first h-8 w-10 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
        />
      </span>
      {invalid && (
        <span id={errorId} className="text-xs [overflow-wrap:anywhere] text-destructive">
          须为 #RRGGBB（如 #147ba9），当前仍使用 {value}
        </span>
      )}
    </span>
  );
}
