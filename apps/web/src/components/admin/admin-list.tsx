/**
 * 后台列表页共享件（审查 F-19）：结果计数行与表格外壳。
 * 新增后台列表页应使用这些件 + lib/admin/query.ts，而不是再手写一遍壳。
 */

import { Pagination } from "@/components/content/pagination";

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
      {/* 行悬停反馈（M16 Step 4，与前台列表一致）：tr 由各页 rows 传入，这里用任意变体在壳上统一挂悬停底色与颜色过渡 */}
      <table className="w-full text-left text-xs [&_tbody>tr]:transition-colors [&_tbody>tr]:hover:bg-accent/50">
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

/** 筛选下拉：name/label/全部项文案/当前值/选项列表，供各列表页复用，避免逐字同构 */
export function AdminFilterSelect({
  name,
  label,
  allLabel,
  value,
  options,
}: {
  name: string;
  label: string;
  allLabel: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      name={name}
      defaultValue={value}
      aria-label={label}
      className="rounded-lg border bg-background px-2.5 py-1.5 text-xs"
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** 计数行 + 分页器：列表页统一复用，basePath 由调用方用 buildAdminQuery 拼好 */
export function AdminListPager({
  total,
  page,
  totalPages,
  basePath,
}: {
  total: number;
  page: number;
  totalPages: number;
  basePath: string;
}) {
  return (
    <>
      <AdminListMeta total={total} page={page} totalPages={totalPages} />
      <Pagination basePath={basePath} page={page} totalPages={totalPages} />
    </>
  );
}

/** 表头列定义 */
export interface AdminColumn {
  label: string;
  className: string;
}

/** 行内单元格：cls 追加到 td 的类名，node 为渲染内容 */
export interface AdminCell {
  cls: string;
  node: React.ReactNode;
}

/**
 * 数据驱动表格：列定义渲染表头，每行单元格数组渲染行。
 * 各列表页只描述「列 + 每行单元格」，壳与渲染逻辑集中在此，避免逐页手写同构 JSX。
 */
export function AdminDataTable({
  columns,
  rows,
  hasRows,
  emptyText,
}: {
  columns: AdminColumn[];
  rows: { key: React.Key; cells: AdminCell[] }[];
  hasRows: boolean;
  emptyText?: string;
}) {
  return (
    <AdminTable
      colSpan={columns.length}
      hasRows={hasRows}
      emptyText={emptyText}
      head={columns.map((c) => (
        <th key={c.label} className={c.className}>
          {c.label}
        </th>
      ))}
      rows={rows.map((r) => (
        <tr key={r.key} className="border-t align-top">
          {r.cells.map((c, i) => (
            <td key={i} className={`px-3 py-1.5 ${c.cls}`.trim()}>
              {c.node}
            </td>
          ))}
        </tr>
      ))}
    />
  );
}
