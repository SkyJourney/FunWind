"use client";

import { useId, useState } from "react";
import { blockEnterSubmit } from "@/components/admin/theme/enter-guard";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** 十进制写法。允许 `5.` 这种没写完的小数点（输入小数必经），不接受科学计数法、十六进制、千分位 */
const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)$/;

export interface NumberRule {
  min: number;
  max: number;
  /** 只接受整数 */
  integer?: boolean;
  /** 非整数时最多保留几位小数，默认 2（与 schema 里 alpha、band.width 的口径一致） */
  decimals?: number;
}

/** 文本 → 满足范围、整数与小数位约束的数；不满足返回 null。-0 规范化为 0 */
export function parseBounded(text: string, rule: NumberRule): number | null {
  const candidate = text.trim();
  if (!NUMBER_RE.test(candidate)) return null;
  const n = Number(candidate);
  if (!Number.isFinite(n) || n < rule.min || n > rule.max) return null;
  const scaled = n * 10 ** (rule.integer ? 0 : (rule.decimals ?? 2));
  if (Math.abs(scaled - Math.round(scaled)) > 1e-8) return null;
  return n === 0 ? 0 : n;
}

/**
 * 数字输入（M11.6 Step 3c）：与 ColorField 同一套契约——`onChange` 只会收到满足范围、整数与小数位约束的数，
 * 没写完或写错的文本只留在本组件内，不进入编辑器的草稿，预览不会因 schema 校验失败而塌成空定义。
 * 不用原生 type="number"：它在空串、`1e3`、滚轮改值上的行为都不可控。
 *
 * 写得合法但不是规范写法的文本（`0.0`、`5.`、`5.10`）会保留在框里直到值被别处改掉：
 * 否则输入 `0.05` 时，`0.0` 一合法就被改写成 `0`，后面的 `5` 就接成了 `05`。
 * 切换编辑对象时调用方应换 key，否则上一个对象没写完的文本会留在框里。
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  integer = false,
  decimals = 2,
  unit,
  testId,
  className,
}: {
  /** 文本框的可访问名称；旁边有可见文字时，应包含该文字 */
  label: string;
  /** 当前生效的值，须满足下面的约束 */
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  integer?: boolean;
  decimals?: number;
  unit?: string;
  testId?: string;
  className?: string;
}) {
  const errorId = useId();
  // draft 是用户最近一次输入的原文（含合法但不规范的写法）；null 表示框里显示规范写法
  const [draft, setDraft] = useState<string | null>(null);
  const rule = { min, max, integer, decimals };
  const parsed = draft === null ? null : parseBounded(draft, rule);
  const invalid = draft !== null && parsed === null;
  // 合法的原文只在它仍等于当前值时显示：值被别处改掉后，应显示新值而不是陈旧的原文
  const text = draft !== null && (parsed === null || parsed === value) ? draft : String(value);

  return (
    <span className={cn("inline-flex min-w-0 flex-col gap-1", className)}>
      <span className="inline-flex items-center gap-1">
        <Input
          type="text"
          inputMode={min < 0 ? undefined : integer ? "numeric" : "decimal"}
          data-testid={testId}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            const result = parseBounded(next, rule);
            if (result === null) {
              setDraft(next);
              return;
            }
            setDraft(String(result) === next.trim() ? null : next);
            // 值没变就不提交（`0.` → `0.0` 这类中间态），避免白白触发编辑器的重算与草稿写入
            if (result !== value) onChange(result);
          }}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={blockEnterSubmit}
          className="h-8 w-20 px-2 text-xs md:text-xs"
        />
        {unit && <span className="shrink-0 text-muted-foreground">{unit}</span>}
      </span>
      {invalid && (
        <span id={errorId} className="text-xs [overflow-wrap:anywhere] text-destructive">
          须为 {min} 到 {max} 的{integer ? "整数" : `数（最多 ${decimals} 位小数）`}，当前仍使用{" "}
          {value}
        </span>
      )}
    </span>
  );
}
