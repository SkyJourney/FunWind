/**
 * 后台列表页共享件（审查 F-19）：结果计数行与表格外壳。
 * 新增后台列表页应使用这些件 + lib/admin/query.ts，而不是再手写一遍壳。
 */

export function AdminListMeta({
  total,
  page,
  totalPages,
}: {
  total: number;
  page: number;
  totalPages: number;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      共 {total} 条 · 第 {page}/{totalPages} 页
    </p>
  );
}

/** 表格壳：表头列由 head（若干 <th>）传入；rows 为行元素；hasRows=false 时渲染空态行 */
export function AdminTable({
  head,
  rows,
  hasRows,
  colSpan,
  emptyText = "无记录。",
}: {
  head: React.ReactNode;
  rows: React.ReactNode;
  hasRows: boolean;
  /** 空态行跨越的列数 */
  colSpan: number;
  emptyText?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-left text-xs">
        <thead className="border-b text-muted-foreground">
          <tr>{head}</tr>
        </thead>
        <tbody>
          {rows}
          {!hasRows && (
            <tr>
              <td colSpan={colSpan} className="px-3 py-6 text-center text-muted-foreground">
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
