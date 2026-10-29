"use client";

/**
 * 变化即提交所在表单的 select（M9.5）：省掉一次「切换」点击。
 * noscript 环境没有 onChange，调用方保留「切换」按钮作回退。
 */
export function AutoSubmitSelect({
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      onChange={(e) => {
        rest.onChange?.(e);
        e.currentTarget.form?.requestSubmit();
      }}
    >
      {children}
    </select>
  );
}
