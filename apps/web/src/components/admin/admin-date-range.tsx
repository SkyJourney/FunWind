/** 日期范围筛选（M19 S3）：两个原生 `<input type="date">`，GET 表单直提、零 JS；
 *  服务端按北京墙面时间解释（to 含当天），见各页服务层的 since/until。 */
export function AdminDateRange({
  from,
  to,
  fromLabel = "开始日期",
  toLabel = "结束日期",
  className = "rounded-lg border bg-background px-2 py-1 text-xs",
}: {
  /** 当前筛选值（YYYY-MM-DD），非法时页面已回落 undefined */
  from?: string;
  to?: string;
  fromLabel?: string;
  toLabel?: string;
  className?: string;
}) {
  return (
    <>
      <input
        type="date"
        name="from"
        defaultValue={from ?? ""}
        aria-label={fromLabel}
        className={className}
      />
      <span aria-hidden className="text-xs text-muted-foreground">
        ~
      </span>
      <input
        type="date"
        name="to"
        defaultValue={to ?? ""}
        aria-label={toLabel}
        className={className}
      />
    </>
  );
}
