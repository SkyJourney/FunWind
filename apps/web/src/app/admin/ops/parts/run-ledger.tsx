import {
  AdminDataTable,
  AdminListPager,
  type AdminCell,
  type AdminColumn,
} from "@/components/admin/admin-list";
import { buildAdminQuery } from "@/lib/admin/query";
import { OpsAutoRefresh } from "@/components/ops/auto-refresh";
import { backupDownloadHref } from "@/lib/ops/runs";
import { fmtSize, KIND_LABEL, TRIGGER_LABEL, STATUS_BADGE } from "./shared";
import type { OpsRunRow } from "@/lib/ops/runs";

/**
 * 运行台账卡（M14 Step 3）：分页表格（失败原因、成功备份的下载链接）+ 执行中自动刷新。
 * 从 page.tsx 拆出（行数软限）——展示组件，不取数。
 */
const LEDGER_COLUMNS: AdminColumn[] = [
  { label: "#", className: "tabular-nums" },
  { label: "任务", className: "" },
  { label: "类别", className: "" },
  { label: "触发", className: "" },
  { label: "状态", className: "" },
  { label: "大小", className: "tabular-nums" },
  { label: "开始时间", className: "whitespace-nowrap tabular-nums" },
  { label: "备注", className: "" },
  { label: "文件", className: "" },
];

export function OpsRunLedger({
  runs,
  page,
  total,
  totalPages,
  pageSize,
  runningCount,
  ledgerMissing,
}: {
  runs: OpsRunRow[];
  page: number;
  total: number;
  /** 真实总页数（M19：COUNT+pageBounds 对齐全站语义） */
  totalPages: number;
  pageSize: number;
  runningCount: number;
  ledgerMissing: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b p-4">
          <h2 className="text-sm font-semibold">运行台账（每页 {pageSize} 条）</h2>
          {ledgerMissing && (
            <span className="text-xs text-muted-foreground">
              运维任务管线尚未部署或尚未启动——台账与触发器状态由管线写入后在此展示。
            </span>
          )}
        </div>
        {runs.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {ledgerMissing
              ? "运行台账尚未建立——运维任务管线部署并完成首次启动后，这里会出现历史。"
              : "暂无记录——管线首次执行后这里会出现历史。"}
          </p>
        ) : (
          <AdminDataTable
            columns={LEDGER_COLUMNS}
            hasRows={runs.length > 0}
            rows={runs.map((r) => {
              const badge = STATUS_BADGE[r.status];
              const download = r.status === "success" ? backupDownloadHref(r.path) : null;
              const cells: AdminCell[] = [
                { cls: "tabular-nums", node: r.id },
                { cls: "", node: r.taskKey ?? "—" },
                { cls: "", node: KIND_LABEL[r.kind] ?? r.kind },
                {
                  cls: "text-muted-foreground",
                  node: TRIGGER_LABEL[r.trigger] ?? r.trigger,
                },
                {
                  cls: "",
                  node: (
                    <>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>
                        {badge.label}
                      </span>
                      {r.error && (
                        <div className="mt-1 max-w-xs text-xs text-destructive">{r.error}</div>
                      )}
                    </>
                  ),
                },
                { cls: "tabular-nums", node: fmtSize(r.sizeBytes) },
                { cls: "whitespace-nowrap tabular-nums", node: r.startedAt },
                {
                  cls: "max-w-xs text-xs text-muted-foreground",
                  node: r.detail ?? "",
                },
                {
                  cls: "",
                  node: download ? (
                    <a
                      className="text-xs whitespace-nowrap text-primary underline hover:no-underline"
                      href={download}
                    >
                      下载
                    </a>
                  ) : null,
                },
              ];
              return { key: r.id, cells };
            })}
          />
        )}
      </div>
      <OpsAutoRefresh running={runningCount > 0} />
      <AdminListPager
        total={total}
        page={page}
        totalPages={totalPages}
        basePath={buildAdminQuery("/admin/ops", pageSize !== 20 ? { size: pageSize } : {})}
        controls={{ action: "/admin/ops", current: {}, size: pageSize }}
      />
    </div>
  );
}
