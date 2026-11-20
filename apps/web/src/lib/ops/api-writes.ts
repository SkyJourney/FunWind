import "server-only";

import { eq } from "drizzle-orm";
import { opsTasks } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import type { ModerationApiTrace, PreparedModerationWrite } from "@/lib/moderation/contents";
import { notifyOpsReload, triggerOpsTask, type OpsTriggerErrorCode } from "./client";
import { validateOpsParams } from "./executors";
import {
  audit,
  bumpTask,
  checkName,
  getManuallyTriggerableTask,
  lockTaskBy,
  recordManualTrigger,
  taskSnapshot,
} from "./tasks";

export const OPS_DENIAL_HTTP = {
  "not-found": "not_found",
  conflict: "state_conflict",
  "bad-input": "bad_request",
} as const;

type OpsDenialCode = keyof typeof OPS_DENIAL_HTTP;

type PreparedOpsWrite = PreparedModerationWrite<
  { id: number; revision: number; enabled?: boolean; changed?: boolean },
  OpsDenialCode
>;

const notFound = { ok: false, code: "not-found" } as const;
const badInput = { ok: false, code: "bad-input" } as const;

/** 配置写入与幂等回执共用调用方事务，提交后再通知管线。 */
export async function prepareApiOpsTaskUpdate(
  actor: ConfigActor,
  taskKey: string,
  expectedRevision: number,
  input: { name?: string; params?: unknown },
  trace: ModerationApiTrace,
): Promise<PreparedOpsWrite> {
  return {
    ok: true,
    async lock(tx) {
      const row = await lockTaskBy(tx, eq(opsTasks.taskKey, taskKey));
      if (!row) return notFound;
      return {
        ok: true,
        async execute() {
          if (row.revision !== expectedRevision) return { ok: false, code: "conflict" };
          const set: { name?: string; params?: typeof row.params } = {};
          if (input.name !== undefined) {
            const name = checkName(input.name);
            if (!name) return badInput;
            set.name = name;
          }
          if (input.params !== undefined) {
            const params = validateOpsParams(row.executor, input.params);
            if (!params.ok) return badInput;
            set.params = params.value;
          }
          if (Object.keys(set).length === 0) return badInput;
          const revision = await bumpTask(tx, row, set);
          await audit(
            tx,
            actor,
            "ops.task.update",
            { type: "ops_task", id: row.taskKey },
            taskSnapshot(row),
            {
              ...set,
              revision,
              ...trace,
            },
          );
          return { ok: true, data: { id: row.id, revision }, afterCommit: reloadOpsConfig };
        },
      };
    },
  };
}

/** 同值启停返回现有修订号，实际变更递增修订号并写入审计。 */
export async function prepareApiOpsTaskEnabled(
  actor: ConfigActor,
  taskKey: string,
  enabled: boolean,
  trace: ModerationApiTrace,
): Promise<PreparedOpsWrite> {
  return {
    ok: true,
    async lock(tx) {
      const row = await lockTaskBy(tx, eq(opsTasks.taskKey, taskKey));
      if (!row) return notFound;
      return {
        ok: true,
        async execute() {
          if (row.enabled === enabled) {
            return {
              ok: true,
              data: { id: row.id, enabled, revision: row.revision, changed: false },
            };
          }
          const revision = await bumpTask(tx, row, { enabled });
          await audit(
            tx,
            actor,
            "ops.task.toggle",
            { type: "ops_task", id: row.taskKey },
            { enabled: row.enabled, revision: row.revision },
            { enabled, revision, ...trace },
          );
          return {
            ok: true,
            data: { id: row.id, enabled, revision, changed: true },
            afterCommit: reloadOpsConfig,
          };
        },
      };
    },
  };
}

async function reloadOpsConfig(): Promise<void> {
  await notifyOpsReload();
}

/** 由管线受理手动运行，先校验本地任务资格，受理后写入审计。 */
export async function triggerManageOpsTask(
  actor: ConfigActor,
  taskKey: string,
  trace: ModerationApiTrace,
): Promise<{ ok: true; runId: number } | { ok: false; code: OpsTriggerErrorCode | "disabled" }> {
  const check = await getManuallyTriggerableTask(taskKey);
  if (!check.ok) {
    return { ok: false, code: check.code === "no-manual-trigger" ? "rejected" : check.code };
  }
  const result = await triggerOpsTask(taskKey);
  if (!result.ok) return { ok: false, code: result.code };
  try {
    await recordManualTrigger(taskKey, result.runId, actor, trace);
  } catch {
    // 跨服务受理已经发生，审计故障仍保留运行编号，避免调用方误重试。
    console.error("[manage:ops.trigger] 受理审计写入失败", {
      taskKey,
      runId: result.runId,
      requestId: trace.requestId,
    });
  }
  return result;
}
