"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { defineAction } from "@/lib/actions/define-action";
import { triggerOpsTask } from "@/lib/ops/client";
import {
  getManuallyTriggerableTask,
  recordManualTrigger,
  setBackupRetention,
  setOpsTaskEnabled,
} from "@/lib/ops/tasks";

const OPS_PAGE = "/admin/ops";

const FAIL_TEXT = {
  "not-found": "任务不存在",
  disabled: "任务已停用（先在任务清单里启用再手动触发）",
  "no-manual-trigger": "该任务没有启用中的手动触发器",
} as const;

/**
 * 手动触发一个任务（M14 Step 3）：异步——运维任务管线受理后立即返回运行编号，执行进度见下方台账。
 * 前置校验（存在 / 启用 / 有手动触发器）在任务配置上完成；受理成功写审计（ops.task.run）。
 */
export const triggerTaskAction = defineAction({
  name: "admin.ops.run",
  auth: { admin: "site.admin" },
  input: z.object({ taskKey: z.string().trim().min(1).max(64) }),
  async run(ctx, input) {
    const check = await getManuallyTriggerableTask(input.taskKey);
    if (!check.ok) redirect(`${OPS_PAGE}?err=${encodeURIComponent(FAIL_TEXT[check.code])}`);
    const result = await triggerOpsTask(check.task.taskKey);
    if (result.ok) await recordManualTrigger(check.task.taskKey, result.runId, ctx.actor);
    revalidatePath(OPS_PAGE);
    if (result.ok)
      redirect(`${OPS_PAGE}?queued=${result.runId}&task=${encodeURIComponent(check.task.taskKey)}`);
    redirect(`${OPS_PAGE}?err=${encodeURIComponent(result.message)}`);
  },
});

/** 任务启停（停用的任务不参与调度，手动触发也被拒）；写服务内带审计与热加载通知。 */
export const setTaskEnabledAction = defineAction({
  name: "admin.ops.task.toggle",
  auth: { admin: "site.admin" },
  input: z.object({ id: z.coerce.number().int().positive(), enabled: z.enum(["0", "1"]) }),
  async run(ctx, input) {
    const result = await setOpsTaskEnabled(input.id, input.enabled === "1", ctx.actor);
    revalidatePath(OPS_PAGE);
    if (result.ok) redirect(`${OPS_PAGE}?tasks=${input.enabled === "1" ? "enabled" : "disabled"}`);
    const message =
      result.code === "conflict"
        ? "任务已被他人修改（版本冲突），刷新后重试"
        : (result.message ?? "操作失败");
    redirect(`${OPS_PAGE}?err=${encodeURIComponent(message)}`);
  },
});

const backupPolicyInput = z.object({
  keepDb: z.coerce.number().int().min(1).max(90),
  keepStorage: z.coerce.number().int().min(1).max(90),
});

/** 保存备份保留份数（M14：写入两条备份任务的参数 keep，带审计；管线热加载后生效）。 */
export const saveBackupPolicyAction = defineAction({
  name: "admin.ops.policy",
  auth: { admin: "site.admin" },
  input: backupPolicyInput,
  async run(ctx, input) {
    const result = await setBackupRetention(
      { keepDb: input.keepDb, keepStorage: input.keepStorage },
      ctx.actor,
    );
    revalidatePath(OPS_PAGE);
    if (result.ok) redirect(`${OPS_PAGE}?policy=saved`);
    redirect(`${OPS_PAGE}?err=${encodeURIComponent(result.message ?? "保留策略保存失败")}`);
  },
});
