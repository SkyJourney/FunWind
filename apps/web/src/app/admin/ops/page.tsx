import { AdminFlash } from "@/components/admin/admin-flash";
import { CopyCode } from "@/components/admin/copy-code";
import { SubmitButton } from "@/components/ui/submit-button";
import { requireAdmin } from "@/lib/authz/require-admin";
import { opsServiceHealth } from "@/lib/ops/client";
import { listOpsRunPage, listOpsTriggerStates, listSuccessfulRuns } from "@/lib/ops/runs";
import { getBackupRetention, listOpsTasks } from "@/lib/ops/tasks";
import { parseDbDateTime } from "@/lib/datetime";
import { parseAdminPage } from "@/lib/admin/query";
import { OpsRunLedger } from "./parts/run-ledger";
import { HolidayRuleForm } from "./holiday-form";
import { saveHolidayRuleAction, setTaskEnabledAction } from "./actions";
import { OpsTaskList } from "./parts/task-list";
import { fmtSize, NOW_MS } from "./parts/shared";
import { PolicyForm } from "./policy-form";
import { saveBackupPolicyAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "运维" };

type Params = { searchParams: Promise<Record<string, string | undefined>> };

/** 恢复命令模板（D5：后台只预览 + 复制，真实恢复走 CLI --yes 双确认） */
function restoreCommand(runId: number, targetDb: string): string {
  return (
    `docker exec funwind-ops python cli.py restore ${runId} --target-db ${targetDb} --dry-run   # 预演\n` +
    `docker exec funwind-ops python cli.py restore ${runId} --target-db ${targetDb} --yes        # 真实恢复（覆盖目标库！）`
  );
}

/**
 * 运维任务中心（M14 Step 3）：任务清单（触发器/下次运行/手动触发/启停）+ 备份速览 + 保留策略 +
 * 恢复预览（D5：只预览 + 复制 CLI）+ 运行台账（分页，执行中自动刷新）。
 * 执行全部在运维任务管线，本页只是管理入口；展示件拆在 parts/（行数软限）。
 */
export default async function AdminOpsPage({ searchParams }: Params) {
  await requireAdmin();
  const sp = await searchParams;
  const page = parseAdminPage(sp.page);
  const [taskList, triggerStates, runPage, dbRuns, storageRuns, svcHealth, policy] =
    await Promise.all([
      listOpsTasks(),
      listOpsTriggerStates(),
      listOpsRunPage(page),
      listSuccessfulRuns("db", 1),
      listSuccessfulRuns("storage", 1),
      opsServiceHealth(),
      getBackupRetention(),
    ]);
  const runs = runPage.rows;
  // 节日装扮规则卡：任务存在才渲染；草稿（上次失败的表单内容）优先回填（G-19）
  const holidayTask = taskList.find((t) => t.executor === "campaign.holiday") ?? null;
  let holidayDraft: Record<string, string> | null = null;
  if (sp.draft) {
    try {
      const parsed: unknown = JSON.parse(sp.draft);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Object.values(parsed).every((v) => typeof v === "string" || Array.isArray(v))
      ) {
        holidayDraft = parsed as Record<string, string>;
      }
    } catch {
      holidayDraft = null;
    }
  }
  const holidayParams = holidayTask
    ? {
        calendar: (holidayTask.params["calendar"] as string) ?? "lunar",
        month: Number(holidayTask.params["month"] ?? 1),
        day: Number(holidayTask.params["day"] ?? 1),
        beforeDays: Number(holidayTask.params["beforeDays"] ?? 0),
        durationDays: Number(holidayTask.params["durationDays"] ?? 7),
        items:
          (holidayTask.params["items"] as { effect: string; target: string }[] | undefined) ?? [],
      }
    : null;
  const lastDb = dbRuns[0];
  const lastStorage = storageRuns[0];
  const runningCount = runs.filter((r) => r.status === "running").length;
  const hoursSince = (finishedAt: string | null): number | null => {
    if (!finishedAt) return null;
    return (NOW_MS - parseDbDateTime(finishedAt).getTime()) / 3600_000;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">运维</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          运维任务清单、备份与运行健康。任务由独立的运维任务管线按触发器执行（本页只做配置与手动触发）；
          保留份数随备份任务参数生效。
        </p>
      </div>

      {sp.queued && (
        <AdminFlash kind="success" dismissHref="/admin/ops">
          已提交执行（{sp.task ?? "任务"}，运行 #{sp.queued}
          ）——由管线在后台执行，下方台账稍后自动出现结果。
        </AdminFlash>
      )}
      {sp.policy === "saved" && (
        <AdminFlash kind="success" dismissHref="/admin/ops">
          保留策略已保存（数据库 {policy.keepDb} 份 / 存储 {policy.keepStorage}{" "}
          份），下一次备份轮转即按新策略执行。
        </AdminFlash>
      )}
      {sp.holiday === "saved" && (
        <AdminFlash kind="success" dismissHref="/admin/ops">
          节日装扮规则已保存。任务启用后，管线每日自检会确保当前或下一年窗口的排期方案存在（已生成的
          方案不会被覆盖，可在排期页微调）。
        </AdminFlash>
      )}
      {sp.holidayErr && (
        <AdminFlash kind="error" dismissHref="/admin/ops">
          {sp.holidayErr === "conflict"
            ? "规则已被他人修改（版本冲突）：下方表单保留了你的修改，请核对当前配置后重新保存。"
            : sp.holidayErr === "bad-items"
              ? "装扮内容格式无效：请检查各行的效果与目标。"
              : sp.holidayErr}
        </AdminFlash>
      )}
      {sp.tasks && (
        <AdminFlash kind="success" dismissHref="/admin/ops">
          任务已{sp.tasks === "enabled" ? "启用" : "停用"}
          ，管线热加载后生效（管线不可达时由周期对账兜底）。
        </AdminFlash>
      )}
      {sp.err && (
        <AdminFlash kind="error" dismissHref="/admin/ops">
          {sp.err}
        </AdminFlash>
      )}

      {/* 任务清单：触发器、下次运行（管线回写）、手动触发与启停；管线健康在卡片头 */}
      <div className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b p-4">
          <h2 className="text-sm font-semibold">任务清单</h2>
          <div className="text-xs text-muted-foreground">
            运维任务管线：
            {svcHealth === null ? (
              "未部署（OPS_SERVICE_URL / OPS_API_TOKEN 未配置）"
            ) : svcHealth.ok ? (
              <span className="text-success">运行中</span>
            ) : (
              <span className="text-destructive">不可达或降级——请检查管线容器</span>
            )}
          </div>
        </div>
        {taskList.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            还没有配置任务——初始化会写入两条备份任务；也可以在这里手工新建（暂无界面时经配置表）。
          </p>
        ) : (
          <OpsTaskList tasks={taskList} triggerStates={triggerStates} />
        )}
      </div>

      {/* 节日装扮规则（campaign.holiday 任务存在时渲染） */}
      {holidayTask && holidayParams && (
        <div className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">节日装扮规则</h2>
            <span
              className={`rounded px-1.5 py-0.5 text-xs ${
                holidayTask.enabled
                  ? "bg-success/10 text-success"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              任务{holidayTask.enabled ? "启用中" : "已停用"}（每日 09:00 自检）
            </span>
          </div>
          <HolidayRuleForm
            action={saveHolidayRuleAction}
            taskId={holidayTask.id}
            revision={holidayTask.revision}
            params={holidayParams}
            draft={holidayDraft}
          />
          {!holidayTask.enabled && holidayTask.id > 0 && (
            <form action={setTaskEnabledAction} className="mt-3">
              <input type="hidden" name="id" value={holidayTask.id} />
              <input type="hidden" name="enabled" value="1" />
              <SubmitButton className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent">
                启用任务（每日自检 + 手动触发）
              </SubmitButton>
            </form>
          )}
        </div>
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
                      ? `⚠ 距上次成功已 ${hours === null ? "—" : hours.toFixed(0)} 小时（超过 26 小时，请检查管线）`
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

      {/* 保留策略（备份任务参数 keep；管线热加载后生效） */}
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

      {/* 恢复预览（D5：后台只预览 + 复制 CLI；真实恢复在容器内执行，--yes 双确认） */}
      <div className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">恢复（CLI 预览）</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          恢复是覆盖目标库的高危操作，不在界面里执行：从下面复制命令，在服务器容器内先
          <code className="mx-1 rounded bg-muted px-1">--dry-run</code>
          预演，确认后再加 <code className="mx-1 rounded bg-muted px-1">--yes</code>
          执行。恢复前管线会自动对目标库做一次安全 dump。详见
          <code className="mx-1 rounded bg-muted px-1">docs/ops/BACKUP.md</code>。
        </p>
        {dbRuns.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            暂无可恢复的数据库备份——备份任务首次成功后，这里会列出最近的可恢复点。
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {dbRuns.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-xs"
                data-testid={`ops-restore-${run.id}`}
              >
                <span className="font-medium tabular-nums">运行 #{run.id}</span>
                <span className="text-muted-foreground tabular-nums">{run.finishedAt}</span>
                <span className="text-muted-foreground">{fmtSize(run.sizeBytes)}</span>
                <CopyCode
                  code={restoreCommand(run.id, "qingyisub")}
                  ariaLabel={`复制运行 ${run.id} 的恢复命令`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 运行台账（分页；执行中自动刷新） */}
      <OpsRunLedger
        runs={runs}
        page={page}
        hasMore={runPage.hasMore}
        runningCount={runningCount}
        ledgerMissing={runPage.ledgerMissing}
      />
    </div>
  );
}
