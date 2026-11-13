import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/authz/require-admin";
import { buildAdminQuery, parseAdminPage } from "@/lib/admin/query";
import { pageBounds } from "@/lib/paging";
import {
  RUM_KINDS,
  RUM_KIND_LABEL,
  parseRumFilter,
  queryRumSamples,
  rumPercentiles,
  rumSummary,
} from "@/lib/rum/queries";
import { RUM_ERROR_NAMES, RUM_VITAL_NAMES } from "@/lib/rum/protocol";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { AdminListMeta, AdminTable } from "@/components/admin/admin-list";
import { Pagination } from "@/components/content/pagination";

export const dynamic = "force-dynamic";
export const metadata = { title: "真实用户监测" };

type Params = { searchParams: Promise<Record<string, string | undefined>> };

const PER_PAGE = 50;

/** 指标值展示：LCP/INP 毫秒；CLS 为 ×1000 值还原；error 无数值语义 */
function displayValue(kind: string, name: string, value: number): string {
  if (kind === "error") return "—";
  if (name === "CLS") return (value / 1000).toFixed(3);
  return `${value}ms`;
}

/** 表头列定义（数据驱动渲染，避免与它页逐字同构） */
const COLUMNS: { label: string; className: string }[] = [
  { label: "id", className: "px-3 py-2" },
  { label: "时间", className: "px-3 py-2" },
  { label: "类别", className: "px-3 py-2" },
  { label: "指标 / 类型", className: "px-3 py-2" },
  { label: "值", className: "px-3 py-2" },
  { label: "路径", className: "px-3 py-2" },
  { label: "错误摘要", className: "hidden px-3 py-2 md:table-cell" },
];

/**
 * 真实用户监测（admin.logs，与审计/邮件同档）：Core Web Vitals 与前端错误的真实用户分布。
 * 与 scripts/lcp.ts 的单点门禁对照而非替代。只存脱敏路径/指标值/错误摘要，不存 IP/UA/堆栈；
 * 保留 90 天，写侧概率清理。
 */
export default async function AdminRumPage({ searchParams }: Params) {
  await requireAdmin("admin.logs");
  const sp = await searchParams;
  const filter = parseRumFilter(sp);
  filter.page = parseAdminPage(sp.page);
  filter.limit = PER_PAGE;

  const [{ items, total }, summary, p75] = await Promise.all([
    queryRumSamples(filter),
    rumSummary(),
    rumPercentiles(),
  ]);
  const { page: safePage, totalPages } = pageBounds(total, filter.page ?? 1, PER_PAGE);
  const qs = { kind: filter.kind, name: filter.name, route: filter.route };
  const selects = [
    {
      name: "kind",
      label: "类别",
      allLabel: "全部类别",
      value: filter.kind ?? "",
      options: RUM_KINDS.map((k) => ({ value: k as string, label: RUM_KIND_LABEL[k] })),
    },
    {
      name: "name",
      label: "指标 / 错误类型",
      allLabel: "全部指标",
      value: filter.name ?? "",
      options: [...RUM_VITAL_NAMES, ...RUM_ERROR_NAMES].map((n) => ({
        value: n as string,
        label: n,
      })),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          最近 24 小时：指标 {summary.vitals} 条 · 错误 {summary.errors} 条 · 共 {total} 条记录
        </p>
        {p75.length > 0 && (
          <p className="text-sm text-muted-foreground">
            p75：
            {p75.map((m) => (
              <span key={m.name} className="ml-2 tabular-nums">
                {m.name} {m.name === "CLS" ? (m.p75 / 1000).toFixed(3) : `${m.p75}ms`}
              </span>
            ))}
          </p>
        )}
      </div>

      <AdminFilterBar
        action="/admin/rum"
        resetHref="/admin/rum"
        placeholder="路径片段（如 /t/）"
        defaultValue={filter.route ?? ""}
      >
        {selects.map((s) => (
          <select
            key={s.name}
            name={s.name}
            defaultValue={s.value}
            aria-label={s.label}
            className="rounded-lg border bg-background px-2.5 py-1.5 text-xs"
          >
            <option value="">{s.allLabel}</option>
            {s.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
      </AdminFilterBar>

      <AdminListMeta total={total} page={safePage} totalPages={totalPages} />
      <Pagination
        basePath={buildAdminQuery("/admin/rum", qs)}
        page={safePage}
        totalPages={totalPages}
      />

      <AdminTable
        colSpan={7}
        hasRows={items.length > 0}
        emptyText="暂无样本。生产环境用户浏览页面后会出现真实指标与错误。"
        head={
          <>
            {COLUMNS.map((c) => (
              <th key={c.label} className={c.className}>
                {c.label}
              </th>
            ))}
          </>
        }
        rows={items.map((r) => {
          const cells: { cls: string; node: ReactNode }[] = [
            { cls: "tabular-nums", node: r.id },
            { cls: "whitespace-nowrap", node: r.createdAt },
            { cls: "", node: RUM_KIND_LABEL[r.kind] ?? r.kind },
            { cls: "font-mono", node: r.name },
            { cls: "tabular-nums", node: displayValue(r.kind, r.name, r.value) },
            {
              cls: "",
              node: (
                <div className="max-w-48 truncate font-mono" title={r.route}>
                  {r.route}
                </div>
              ),
            },
            {
              cls: "hidden md:table-cell",
              node: r.detail ? (
                <div className="max-w-64 truncate text-muted-foreground" title={r.detail}>
                  {r.detail}
                </div>
              ) : (
                "—"
              ),
            },
          ];
          return (
            <tr key={r.id} className="border-t align-top">
              {cells.map((c, i) => (
                <td key={i} className={`px-3 py-1.5 ${c.cls}`.trim()}>
                  {c.node}
                </td>
              ))}
            </tr>
          );
        })}
      />
      <p className="text-xs text-muted-foreground">
        只存脱敏路径 / 指标值 / 错误摘要，不存 IP / UA / 堆栈 / 正文；保留 90 天，超期自动清理。 p75
        为最近 24 小时真实用户分布，与构建后单点 LCP 门禁对照使用。
      </p>
    </div>
  );
}
