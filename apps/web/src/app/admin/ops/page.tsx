import { AdminFlash } from "@/components/admin/admin-flash";
import { requireAdmin } from "@/lib/authz/require-admin";
import { backupServiceHealth, listBackupRuns, type BackupRunRow } from "@/lib/ops/backup";
import { PolicyForm } from "./policy-form";
import { TriggerBackupForm } from "./trigger-form";
import { getBackupPolicy } from "@/lib/ops/backup";
import { saveBackupPolicyAction, triggerBackupAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "运维" };

type Params = { searchParams: Promise<Record<string, string | undefined>> };

function fmtSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

const KIND_LABEL: Record<BackupRunRow["kind"], string> = {
  db: "数据库",
  storage: "存储",
  restore: "恢复",
};

const STATUS_BADGE: Record<BackupRunRow["status"], { label: string; cls: string }> = {
  running: { label: "执行中", cls: "bg-warning/10 text-warning" },
  success: { label: "成功", cls: "bg-success/10 text-success" },
  failed: { label: "失败", cls: "bg-destructive/10 text-destructive" },
};

/** 运维（M13 追加）：备份历史（元数据由备份服务容器写入 backup_runs 表）+ 手动触发 + 服务健康。 */
export default async function AdminOpsPage({ searchParams }: Params) {
  await requireAdmin();
  const sp = await searchParams;
  const [runs, svcHealth, policy] = await Promise.all([
    listBackupRuns(50),
    backupServiceHealth(),
    getBackupPolicy(),
  ]);

  const lastDb = runs.find((r) => r.kind === "db" && r.status === "success");
  const lastStorage = runs.find((r) => r.kind === "storage" && r.status === "success");
  const hoursSince = (finishedAt: string | null): number | null => {
    if (!finishedAt) return null;
    return (new Date().getTime() - new Date(finishedAt.replace(" ", "T")).getTime()) / 3600_000;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">运维</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          备份与运行健康。备份由独立备份服务容器执行（每日 03:10 数据库 / 03:40 存储， 保留 DB 14
          份、存储 7 份）；本页为管理入口与状态查询。
        </p>
      </div>

      {sp.done && (
        <AdminFlash kind="success" dismissHref="/admin/ops">
          备份完成（{sp.backup === "storage" ? "存储" : "数据库"}），下方历史已刷新。
        </AdminFlash>
      )}
      {sp.policy === "saved" && (
        <AdminFlash kind="success" dismissHref="/admin/ops">
          保留策略已保存（数据库 {policy.keepDb} 份 / 存储 {policy.keepStorage}{" "}
          份），下一次备份轮转即按新策略执行。
        </AdminFlash>
      )}
      {sp.err && (
        <AdminFlash kind="error" dismissHref="/admin/ops">
          {sp.err}
        </AdminFlash>
      )}

      {/* 备份状态速览 */}
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            { label: "上次数据库备份", row: lastDb },
            { label: "上次存储备份", row: lastStorage },
          ] as const
        ).map(({ label, row }) => {
          const hours = row ? hoursSince(row.finishedAt) : null;
          const stale = hours === null || hours > 26;
          return (
            <div key={label} className="rounded-xl border bg-card p-4 text-sm">
              <div className="font-medium">{label}</div>
              {row ? (
                <>
                  <div className="mt-1 text-muted-foreground">
                    {row.finishedAt} · {fmtSize(row.sizeBytes)}
                  </div>
                  <div className={`mt-1 ${stale ? "text-destructive" : "text-success"}`}>
                    {stale
                      ? `⚠ 距上次成功已 ${hours === null ? "—" : hours.toFixed(0)} 小时（超过 26 小时，请检查备份服务）`
                      : "正常（26 小时内）"}
                  </div>
                </>
              ) : (
                <div className="mt-1 text-destructive">⚠ 从未成功备份</div>
              )}
            </div>
          );
        })}
      </div>

      {/* 手动触发 + 服务健康 */}
      <div className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">手动备份</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          立即执行一次（与定时备份同池参与保留轮转）。升级版本前建议先手动备份数据库与存储。
        </p>
        <TriggerBackupForm action={triggerBackupAction} />
        <div className="mt-3 text-xs text-muted-foreground">
          备份服务：
          {svcHealth === null ? (
            "未部署（BACKUP_SERVICE_URL / BACKUP_OPS_TOKEN 未配置；定时备份由宿主机 crontab 承担）"
          ) : svcHealth.ok ? (
            <span className="text-success">
              运行中（调度任务：{svcHealth.jobs.join("、") || "无"}）
            </span>
          ) : (
            <span className="text-destructive">不可达——请检查备份服务容器</span>
          )}
        </div>
      </div>

      {/* 保留策略（site_settings ops.backup.policy；备份服务轮转时动态读取） */}
      <div className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">备份保留策略</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          按份数轮转，超出即删除最旧的一份（手动与定时同池）。storage 备份单份约
          95MB，份数越大占用越高。
        </p>
        <PolicyForm
          action={saveBackupPolicyAction}
          keepDb={policy.keepDb}
          keepStorage={policy.keepStorage}
        />
      </div>

      {/* 历史列表 */}
      <div className="rounded-xl border bg-card">
        <div className="border-b p-4 text-sm font-semibold">备份历史（最近 50 条）</div>
        {runs.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            暂无记录——备份服务首次执行后这里会出现历史（元数据由备份服务写入 backup_runs 表）。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="p-3 font-medium">#</th>
                  <th className="p-3 font-medium">类型</th>
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
                  return (
                    <tr key={r.id} className="border-b align-top last:border-0">
                      <td className="p-3 tabular-nums">{r.id}</td>
                      <td className="p-3">{KIND_LABEL[r.kind] ?? r.kind}</td>
                      <td className="p-3 text-muted-foreground">
                        {r.trigger === "cron" ? "定时" : "手动"}
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
