import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/**
 * 后台二级页统一页头（M9.5）：返回链接 + 页面标题 + 统计行 + 右侧主操作区。
 * 页面级标题用 h2——「后台管理」h1 在布局壳内，保持全后台唯一 h1 层级。
 */
export function AdminPageHeader({
  back,
  backLabel,
  title,
  stats,
  actions,
}: {
  back: string;
  backLabel: string;
  title: React.ReactNode;
  stats?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <Link
          href={back}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> {backLabel}
        </Link>
        <h2 className="mt-0.5 truncate text-lg font-bold tracking-tight">{title}</h2>
        {stats && <p className="mt-1 text-sm text-muted-foreground">{stats}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
