import Link from "next/link";
import { cn } from "@/lib/utils";
import { ActionGroup } from "@/components/ui/action-group";
import { controlLayout } from "@/components/ui/control-layout";

/**
 * 后台筛选栏统一形态（M9.5）：GET 表单（筛选状态持久在 URL），关键词 + 若干 select 筛项 + 筛选/重置。
 * 服务端组件，零 JS；各页筛项由调用方以 children（select/输入等裸控件）传入，控件自带 name 即可。
 */
export function AdminFilterBar({
  action,
  children,
  resetHref,
  placeholder,
  keywordName = "q",
  defaultValue = "",
  hidden,
  total,
  method,
  className = "flex flex-wrap items-center gap-2 text-sm",
  submitClassName = "rounded-lg border px-3 py-1.5 hover:bg-accent",
}: {
  action: string;
  children?: React.ReactNode;
  /** 不带任何筛选的页面 URL（重置用） */
  resetHref?: string;
  placeholder?: string;
  keywordName?: string;
  defaultValue?: string;
  hidden?: Record<string, string | undefined>;
  /** 筛选按钮 / 重置之后的总数或补充内容，沿用页面自己的标签与样式。 */
  total?: React.ReactNode;
  method?: "get";
  className?: string;
  submitClassName?: string;
}) {
  const hasKeyword = placeholder !== undefined;
  return (
    <form action={action} method={method} className={cn("max-w-full min-w-0", className)}>
      {Object.entries(hidden ?? {}).map(([name, value]) =>
        value === undefined ? null : <input key={name} type="hidden" name={name} value={value} />,
      )}
      {children}
      {hasKeyword && (
        <input
          type="search"
          name={keywordName}
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="w-44 max-w-full min-w-0 rounded-lg border bg-background px-3 py-1.5 outline-none focus:ring-2 focus:ring-ring"
        />
      )}
      <ActionGroup className="gap-2">
        <button type="submit" className={cn(controlLayout, submitClassName)}>
          筛选
        </button>
        {resetHref !== undefined && (
          <Link
            href={resetHref}
            className={cn(controlLayout, "text-xs text-muted-foreground hover:text-foreground")}
          >
            重置
          </Link>
        )}
      </ActionGroup>
      {total}
    </form>
  );
}
