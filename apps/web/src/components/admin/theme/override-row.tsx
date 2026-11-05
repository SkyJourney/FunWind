import type { ReactNode } from "react";

/** 只读色块：继承时显示基础层的颜色，对读屏隐藏（旁边的十六进制文字已经说明了颜色） */
export function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-6 shrink-0 rounded border"
      style={{ backgroundColor: color }}
    />
  );
}

/**
 * 「继承 / 覆盖」行（M11.6 Step 3c）：令牌缺省 = 继承基础层。
 * 继承时只读显示继承来源和一个「覆盖」按钮；覆盖后显示编辑控件和「恢复继承」按钮。
 * 版式：窄屏标签独占一行；内容区可收缩（basis 10rem，放不下就换行），按钮单行且不收缩。
 */
export function OverrideRow({
  label,
  overridden,
  inherited,
  onOverride,
  onRestore,
  children,
}: {
  label: string;
  overridden: boolean;
  /** 继承时显示的内容（继承来源、基础值） */
  inherited: ReactNode;
  onOverride: () => void;
  onRestore: () => void;
  /** 覆盖后显示的编辑控件 */
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5 text-xs">
      <span className="w-full pt-1 text-muted-foreground sm:w-32 sm:shrink-0 sm:pt-2">{label}</span>
      <div className="flex min-w-0 flex-1 basis-40 flex-wrap items-start gap-x-3 gap-y-2">
        {overridden ? (
          children
        ) : (
          <span className="flex min-w-0 items-center gap-2 pt-1.5 [overflow-wrap:anywhere] text-muted-foreground">
            {inherited}
          </span>
        )}
      </div>
      <button
        type="button"
        aria-label={`${label}：${overridden ? "恢复继承" : "覆盖"}`}
        onClick={overridden ? onRestore : onOverride}
        className="shrink-0 rounded-md border px-2 py-1 whitespace-nowrap hover:bg-accent"
      >
        {overridden ? "恢复继承" : "覆盖"}
      </button>
    </div>
  );
}
