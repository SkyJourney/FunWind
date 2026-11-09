import { Pagination } from "@/components/content/pagination";
import { OpsAutoRefresh } from "@/components/ops/auto-refresh";
import { backupDownloadHref } from "@/lib/ops/runs";
import { fmtSize, KIND_LABEL, TRIGGER_LABEL, STATUS_BADGE } from "./shared";
import type { OpsRunRow } from "@/lib/ops/runs";

/**
 * 运行台账卡（M14 Step 3）：分页表格（失败原因、成功备份的下载链接）+ 执行中自动刷新。
 * 从 page.tsx 拆出（行数软限）——展示组件，不取数。
 */
export function OpsRunLedger({
  runs,
  page,
  hasMore,
  runningCount,
  ledgerMissing,
}: {
  runs: OpsRunRow[];
  page: number;
  hasMore: boolean;
  runningCount: number;
  ledgerMissing: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b p-4">
          <h2 className="text-sm font-semibold">运行台账（第 {page} 页，每页 25 条）</h2>
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="p-3 font-medium">#</th>
                  <th className="p-3 font-medium">任务</th>
                  <th className="p-3 font-medium">类别</th>
                  <th className="p-3 font-medium">触发</th>
                  <th className="p-3 font-medium">状态</th>
                  <th className="p-3 font-medium">大小</th>
                  <th className="p-3 font-medium">开始时间</th>
                  <th className="p-3 font-medium">备注</th>
                  <th className="p-3 font-medium">文件</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const badge = STATUS_BADGE[r.status];
                  const download = r.status === "success" ? backupDownloadHref(r.path) : null;
                  return (
                    <tr key={r.id} className="border-b align-top last:border-0">
                      <td className="p-3 tabular-nums">{r.id}</td>
                      <td className="p-3">{r.taskKey ?? "—"}</td>
                      <td className="p-3">{KIND_LABEL[r.kind] ?? r.kind}</td>
                      <td className="p-3 text-muted-foreground">
                        {TRIGGER_LABEL[r.trigger] ?? r.trigger}
                      </td>
                      <td className="p-3">
                        <span className={`rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>
                          {badge.label}
                        </span>
                        {r.error && (
                          <div className="mt-1 max-w-xs text-xs text-destructive">{r.error}</div>
                        )}
                      </td>
                      <td className="p-3 tabular-nums">{fmtSize(r.sizeBytes)}</td>
                      <td className="p-3 whitespace-nowrap tabular-nums">{r.startedAt}</td>
                      <td className="max-w-xs p-3 text-xs text-muted-foreground">
                        {r.detail ?? ""}
                      </td>
                      <td className="p-3">
                        {download && (
                          <a
                            className="text-xs whitespace-nowrap text-primary underline hover:no-underline"
                            href={download}
                          >
                            下载
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <OpsAutoRefresh running={runningCount > 0} />
      <Pagination basePath="/admin/ops" page={page} totalPages={page + (hasMore ? 1 : 0)} />
    </div>
  );
}
