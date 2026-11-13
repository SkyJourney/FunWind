import { requireAdmin } from "@/lib/authz/require-admin";
import { buildAdminQuery, parseAdminPage } from "@/lib/admin/query";
import { pageBounds } from "@/lib/paging";
import { cspSummary, parseCspFilter, queryCspReports } from "@/lib/csp/queries";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import {
  AdminDataTable,
  AdminFilterSelect,
  AdminListPager,
  type AdminCell,
} from "@/components/admin/admin-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "CSP 违规报告" };

type Params = { searchParams: Promise<Record<string, string | undefined>> };

const PER_PAGE = 50;

/** 常见 CSP 指令（筛选用；实际值以报告为准） */
const DIRECTIVES = [
  "script-src",
  "style-src",
  "img-src",
  "connect-src",
  "font-src",
  "media-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
  "default-src",
  "worker-src",
];

const COLUMNS: { label: string; className: string }[] = [
  { label: "id", className: "px-3 py-2" },
  { label: "时间", className: "px-3 py-2" },
  { label: "指令", className: "px-3 py-2" },
  { label: "被阻资源", className: "px-3 py-2" },
  { label: "文档", className: "px-3 py-2" },
  { label: "处置", className: "hidden px-3 py-2 md:table-cell" },
];

/**
 * CSP 违规报告（admin.logs，M17 Step 6）：Report-Only 预演收集到的违规，可查询。
 * 是 Report-Only 转强制的数据前提——观察窗口内违规清零才考虑转强制，否则只交报告面。
 * 所有 URI 已脱敏（令牌段→:token、去查询串）；不存 IP/UA/正文；保留 90 天。
 */
export default async function AdminCspPage({ searchParams }: Params) {
  await requireAdmin("admin.logs");
  const sp = await searchParams;
  const filter = parseCspFilter(sp);
  filter.page = parseAdminPage(sp.page);
  filter.limit = PER_PAGE;

  const [{ items, total }, summary] = await Promise.all([queryCspReports(filter), cspSummary()]);
  const { page: safePage, totalPages } = pageBounds(total, filter.page ?? 1, PER_PAGE);
  const qs = { directive: filter.directive, document: filter.document };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          最近 24 小时违规 {summary.recent} 条 · 共 {total} 条记录
        </p>
        {summary.top.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Top 指令：
            {summary.top.map((t) => (
              <span key={t.directive} className="ml-2 font-mono tabular-nums">
                {t.directive}×{t.n}
              </span>
            ))}
          </p>
        )}
      </div>

      <AdminFilterBar
        action="/admin/csp"
        resetHref="/admin/csp"
        placeholder="文档路径片段（如 /admin/themes）"
        defaultValue={filter.document ?? ""}
      >
        <AdminFilterSelect
          name="directive"
          label="指令"
          allLabel="全部指令"
          value={filter.directive ?? ""}
          options={DIRECTIVES.map((d) => ({ value: d, label: d }))}
        />
      </AdminFilterBar>

      <AdminListPager
        total={total}
        page={safePage}
        totalPages={totalPages}
        basePath={buildAdminQuery("/admin/csp", qs)}
      />

      <AdminDataTable
        columns={COLUMNS}
        hasRows={items.length > 0}
        emptyText="最近暂无违规。Report-Only 预演未收集到违规是转强制的前提之一。"
        rows={items.map((r) => {
          const cells: AdminCell[] = [
            { cls: "tabular-nums", node: r.id },
            { cls: "whitespace-nowrap", node: r.createdAt },
            { cls: "font-mono", node: r.violatedDirective },
            {
              cls: "",
              node: (
                <div className="max-w-48 truncate font-mono" title={r.blockedUri ?? undefined}>
                  {r.blockedUri ?? "inline"}
                </div>
              ),
            },
            {
              cls: "",
              node: (
                <div className="max-w-48 truncate font-mono" title={r.documentUri ?? undefined}>
                  {r.documentUri ?? "—"}
                </div>
              ),
            },
            { cls: "hidden md:table-cell", node: r.disposition ?? "report" },
          ];
          return { key: r.id, cells };
        })}
      />
      <p className="text-xs text-muted-foreground">
        当前 CSP 仍为
        Report-Only（不拦截）。转强制前须确认观察窗口内（覆盖前后台主要路径）违规清零； 已知
        /admin/themes 编辑器存在 eval 违规，故本期不转强制。URI 已脱敏，保留 90 天。
      </p>
    </div>
  );
}
