/**
 * 后台列表页共享件（审查 F-19；M19 S3 加多尺寸/密度）：结果计数行与表格外壳。
 * 新增后台列表页应使用这些件 + lib/admin/query.ts，而不是再手写一遍壳。
 */

import Link from "next/link";
import { Pagination } from "@/components/content/pagination";
import { AutoSubmitSelect } from "@/components/admin/auto-submit-select";
import {
  ADMIN_PAGE_SIZES,
  buildAdminQuery,
  densityCellClass,
  type AdminDensity,
} from "@/lib/admin/query";

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

/** 密度切换目标链接：默认档（cozy）不进 URL，保持「默认值不出现在 query」纪律 */
function densityHref(
  action: string,
  current: Record<string, string | undefined>,
  density: AdminDensity,
): string {
  return buildAdminQuery(action, { ...current, density: density === "cozy" ? "" : density });
}

/** 多尺寸/密度控件（M19 S3）：可选——不传时 AdminListPager 渲染与 M9.5 形态完全一致 */
export interface AdminPagerControls {
  /** 每页条数表单的 GET 提交目标（当前列表页路径） */
  action: string;
  /** 需要随切档保留的当前筛选（不含 page/size/density；空值字段自动跳过） */
  current: Record<string, string | undefined>;
  size: number;
  density: AdminDensity;
}

/** 计数行 + 分页器：列表页统一复用，basePath 由调用方用 buildAdminQuery 拼好。
 *  传 controls 时额外渲染「每页 N 条」（GET 表单 + AutoSubmitSelect，noscript 回退）
 *  与密度两档切换（链接式，零 JS 可用）。 */
export function AdminListPager({
  total,
  page,
  totalPages,
  basePath,
  controls,
}: {
  total: number;
  page: number;
  totalPages: number;
  basePath: string;
  controls?: AdminPagerControls;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <AdminListMeta total={total} page={page} totalPages={totalPages} />
        {controls && (
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <form action={controls.action} method="get" className="flex items-center gap-1">
              {Object.entries(controls.current).map(([name, value]) =>
                value ? <input key={name} type="hidden" name={name} value={value} /> : null,
              )}
              <label className="flex items-center gap-1">
                每页
                <AutoSubmitSelect
                  name="size"
                  defaultValue={String(controls.size)}
                  aria-label="每页条数"
                  className="mx-0.5 rounded border bg-background px-1.5 py-0.5"
                >
                  {ADMIN_PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </AutoSubmitSelect>
                条
              </label>
              <noscript>
                <button type="submit" className="rounded border px-1.5 py-0.5 hover:bg-accent">
                  切换
                </button>
              </noscript>
            </form>
            <span className="flex items-center gap-1">
              密度
              <Link
                href={densityHref(controls.action, controls.current, "compact")}
                aria-current={controls.density === "compact" ? "true" : undefined}
                className={`rounded border px-1.5 py-0.5 ${
                  controls.density === "compact"
                    ? "bg-accent font-medium text-foreground"
                    : "hover:bg-accent"
                }`}
              >
                紧凑
              </Link>
              <Link
                href={densityHref(controls.action, controls.current, "cozy")}
                aria-current={controls.density === "cozy" ? "true" : undefined}
                className={`rounded border px-1.5 py-0.5 ${
                  controls.density === "cozy"
                    ? "bg-accent font-medium text-foreground"
                    : "hover:bg-accent"
                }`}
              >
                舒适
              </Link>
            </span>
          </div>
        )}
      </div>
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
 * density（M19 S3）：compact 收紧单元格 padding；缺省 cozy 与原形态一致。
 */
export function AdminDataTable({
  columns,
  rows,
  hasRows,
  emptyText,
  density = "cozy",
}: {
  columns: AdminColumn[];
  rows: { key: React.Key; cells: AdminCell[] }[];
  hasRows: boolean;
  emptyText?: string;
  density?: AdminDensity;
}) {
  const cell = densityCellClass(density);
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
            <td key={i} className={`${cell} ${c.cls}`.trim()}>
              {c.node}
            </td>
          ))}
        </tr>
      ))}
    />
  );
}
