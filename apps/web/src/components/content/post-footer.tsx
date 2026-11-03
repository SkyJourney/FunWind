import type { ReactNode } from "react";

/** 元信息与交互区分离，操作行根据自身宽度换行，不与时间文本竞争空间。 */
export function PostFooter({
  like,
  timestamp,
  children,
}: {
  like: ReactNode;
  timestamp?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mt-3 min-w-0 space-y-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        {like}
        {timestamp && (
          <span className="min-w-0 [overflow-wrap:anywhere] text-muted-foreground">
            {timestamp}
          </span>
        )}
      </div>
      {children && <div className="min-w-0">{children}</div>}
    </div>
  );
}
