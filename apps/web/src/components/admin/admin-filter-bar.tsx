import Link from "next/link";

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
}: {
  action: string;
  children?: React.ReactNode;
  /** 不带任何筛选的页面 URL（重置用） */
  resetHref: string;
  placeholder?: string;
  keywordName?: string;
  defaultValue?: string;
}) {
  const hasKeyword = placeholder !== undefined;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 text-sm">
      {children}
      {hasKeyword && (
        <input
          type="search"
          name={keywordName}
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="w-44 rounded-lg border bg-background px-3 py-1.5 outline-none focus:ring-2 focus:ring-ring"
        />
      )}
      <button type="submit" className="rounded-lg border px-3 py-1.5 hover:bg-accent">
        筛选
      </button>
      <Link href={resetHref} className="text-xs text-muted-foreground hover:text-foreground">
        重置
      </Link>
    </form>
  );
}
