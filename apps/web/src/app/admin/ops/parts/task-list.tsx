import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { setTaskEnabledAction, triggerTaskAction } from "../actions";
import { RESULT_TEXT, TRIGGER_LABEL } from "./shared";
import { SubmitButton } from "@/components/ui/submit-button";
import type { OpsTriggerStateRow } from "@/lib/ops/runs";
import type { OpsTaskView } from "@/lib/ops/tasks";

/**
 * 任务清单卡（M14 Step 3）：每个任务一行——启用状态、触发器（表达式 + 管线回写的下次/上次触发）、
 * 手动触发按钮（有启用中的手动触发器才显示）、启停（确认框）。从 page.tsx 拆出（行数软限）——展示组件。
 */
export function OpsTaskList({
  tasks,
  triggerStates,
}: {
  tasks: OpsTaskView[];
  /** null = 管线尚未回写状态（未部署或未启动） */
  triggerStates: OpsTriggerStateRow[] | null;
}) {
  const states = new Map((triggerStates ?? []).map((state) => [state.triggerKey, state]));
  return (
    <>
      {tasks.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          还没有配置任务——初始化会写入两条备份任务；也可以在这里手工新建（暂无界面时经配置表）。
        </p>
      ) : (
        <div className="divide-y">
          {tasks.map((task) => {
            const manual = task.triggers.find((t) => t.kind === "manual" && t.enabled);
            return (
              <div key={task.id} className="flex flex-wrap items-start gap-x-6 gap-y-2 p-4 text-sm">
                <div className="min-w-0 flex-[2_1_16rem]">
                  <p className="font-medium">
                    {task.name}
                    <span
                      className={`ml-2 rounded px-1.5 py-0.5 align-middle text-xs ${
                        task.enabled
                          ? "bg-success/10 text-success"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {task.enabled ? "启用中" : "已停用"}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {task.taskKey} · {task.executor}
                  </p>
                </div>
                <ul className="min-w-0 flex-[3_1_20rem] space-y-1 text-xs text-muted-foreground">
                  {task.triggers.length === 0 && <li>没有触发器（只能通过台账审计追溯）</li>}
                  {task.triggers.map((trigger) => {
                    const state = states.get(
                      // 管线回写的键：配置触发器为 t{id}，内置默认回落为 default:…
                      trigger.id ? `t${trigger.id}` : "",
                    );
                    return (
                      <li key={trigger.id} data-testid={`ops-trigger-${trigger.id}`}>
                        {TRIGGER_LABEL[trigger.kind]}
                        {trigger.expr ? ` ${trigger.expr}` : ""}
                        {!trigger.enabled && "（已停用）"}
                        {triggerStates === null
                          ? " · 管线尚未回写状态（未部署或未启动）"
                          : state && (
                              <>
                                {" · 下次 "}
                                <span className="tabular-nums">{state.nextFireAt ?? "—"}</span>
                                {state.lastFiredAt && (
                                  <>
                                    {" · 上次 "}
                                    <span className="tabular-nums">{state.lastFiredAt}</span>
                                    {state.lastResult && ` ${RESULT_TEXT[state.lastResult]}`}
                                    {state.lastRunId != null && `（运行 #${state.lastRunId}）`}
                                  </>
                                )}
                              </>
                            )}
                      </li>
                    );
                  })}
                </ul>
                <div className="ml-auto flex flex-none flex-wrap items-center gap-2">
                  {manual && (
                    <form action={triggerTaskAction}>
                      <input type="hidden" name="taskKey" value={task.taskKey} />
                      <SubmitButton
                        disabled={!task.enabled}
                        className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        立即执行
                      </SubmitButton>
                    </form>
                  )}
                  <form action={setTaskEnabledAction}>
                    <input type="hidden" name="id" value={task.id} />
                    <input type="hidden" name="enabled" value={task.enabled ? "0" : "1"} />
                    <ConfirmSubmit
                      title={task.enabled ? "停用该任务？" : "启用该任务？"}
                      description={
                        task.enabled
                          ? "停用后所有触发器都不再调度，手动触发也会被拒绝；随时可重新启用。"
                          : "启用后管线将在下一次热加载/对账时恢复调度。"
                      }
                      className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
                      pendingText="处理中…"
                    >
                      {task.enabled ? "停用" : "启用"}
                    </ConfirmSubmit>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
