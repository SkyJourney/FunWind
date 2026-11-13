import { requireAdmin } from "@/lib/authz/require-admin";
import { buildAdminQuery, parseAdminPage } from "@/lib/admin/query";
import { pageBounds } from "@/lib/paging";
import {
  PUSH_SCENES,
  PUSH_SCENE_LABEL,
  parsePushLogFilter,
  pushLogSummary,
  queryPushLogs,
} from "@/lib/push/log-query";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import {
  AdminDataTable,
  AdminFilterSelect,
  AdminListPager,
  type AdminCell,
} from "@/components/admin/admin-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "推送记录" };

type Params = { searchParams: Promise<Record<string, string | undefined>> };

const PER_PAGE = 50;

const COLUMNS = [
  { label: "id", className: "px-3 py-2" },
  { label: "时间", className: "px-3 py-2" },
  { label: "场景", className: "px-3 py-2" },
  { label: "订阅 endpoint", className: "px-3 py-2" },
  { label: "标题", className: "px-3 py-2" },
  { label: "状态", className: "px-3 py-2" },
  { label: "耗时", className: "hidden px-3 py-2 md:table-cell" },
];

/**
 * 推送发送记录（admin.logs，与审计/邮件同档，M18 Step 6）：凡经 lib/push 发出的推送成败皆在此可查。
 * 不含正文 payload；保留 90 天，超期自动清理；失效订阅（404/410）即时清除。
 */
export default async function AdminPushPage({ searchParams }: Params) {
  await requireAdmin("admin.logs");
  const sp = await searchParams;
  const filter = parsePushLogFilter(sp);
  filter.page = parseAdminPage(sp.page);
  filter.limit = PER_PAGE;

  const [{ items, total }, summary] = await Promise.all([queryPushLogs(filter), pushLogSummary()]);
  const { page: safePage, totalPages } = pageBounds(total, filter.page ?? 1, PER_PAGE);
  const qs = { status: filter.status, scene: filter.scene, q: filter.q };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        最近 24 小时：送达 {summary.sent} 条 · 失败 {summary.failed} 条 · 共 {total} 条记录
      </p>

      <AdminFilterBar
        action="/admin/push"
        resetHref="/admin/push"
        placeholder="endpoint 片段或用户 id"
        defaultValue={filter.q ?? ""}
      >
        <AdminFilterSelect
          name="status"
          label="状态"
          allLabel="全部状态"
          value={filter.status ?? ""}
          options={[
            { value: "sent", label: "成功" },
            { value: "failed", label: "失败" },
          ]}
        />
        <AdminFilterSelect
          name="scene"
          label="场景"
          allLabel="全部场景"
          value={filter.scene ?? ""}
          options={PUSH_SCENES.map((s) => ({ value: s, label: PUSH_SCENE_LABEL[s] }))}
        />
      </AdminFilterBar>

      <AdminListPager
        total={total}
        page={safePage}
        totalPages={totalPages}
        basePath={buildAdminQuery("/admin/push", qs)}
      />

      <AdminDataTable
        columns={COLUMNS}
        hasRows={items.length > 0}
        emptyText="无记录。站点发出第一条推送后会出现在这里。"
        rows={items.map((r) => {
          const cells: AdminCell[] = [
            { cls: "tabular-nums", node: r.id },
            { cls: "whitespace-nowrap", node: r.createdAt },
            { cls: "", node: PUSH_SCENE_LABEL[r.scene] ?? r.scene },
            {
              cls: "",
              node: (
                <div className="max-w-48 truncate font-mono" title={r.endpoint}>
                  {r.endpoint}
                </div>
              ),
            },
            {
              cls: "",
              node: (
                <div className="max-w-48 truncate" title={r.title}>
                  {r.title}
                </div>
              ),
            },
            {
              cls: "",
              node:
                r.status === "sent" ? (
                  <span className="text-success">成功</span>
                ) : (
                  <span className="text-destructive" title={r.error ?? undefined}>
                    失败{r.error ? "（悬停见原因）" : ""}
                  </span>
                ),
            },
            {
              cls: "hidden md:table-cell",
              node: r.durationMs !== null ? `${r.durationMs}ms` : "—",
            },
          ];
          return { key: r.id, cells };
        })}
      />
      <p className="text-xs text-muted-foreground">
        记录只含 endpoint / 标题 / 场景 / 结果，不含推送正文；保留 90 天，超期自动清理。
      </p>
    </div>
  );
}
