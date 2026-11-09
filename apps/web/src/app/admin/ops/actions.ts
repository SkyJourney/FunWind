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
  updateOpsTask,
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

// ── 节日装扮规则（M14 Step 4） ────────────────────────────

const HOLIDAY_DRAFT_MAX = 2400;

/** 节日规则表单提交失败（G-19）：整份表单编码进 draft 参数带回，不清空工作成果 */
function holidayFail(query: string, draft: Record<string, unknown>): never {
  redirect(
    `${OPS_PAGE}?${query}&draft=${encodeURIComponent(JSON.stringify(draft).slice(0, HOLIDAY_DRAFT_MAX))}`,
  );
}

const holidayFormInput = z.object({
  id: z.coerce.number().int().positive(),
  revision: z.coerce.number().int().nonnegative(),
  calendar: z.enum(["solar", "lunar"]),
  month: z.coerce.number().int().min(1).max(12),
  day: z.coerce.number().int().min(0).max(31),
  beforeDays: z.coerce.number().int().min(0).max(30),
  durationDays: z.coerce.number().int().min(1).max(90),
  /** 固定 3 行的同名多值字段（formDataToObject 归并为数组；单值兼容字符串） */
  itemEffect: z.union([z.array(z.string()), z.string()]).default(""),
  itemTarget: z.union([z.array(z.string()), z.string()]).default(""),
});

function asStringArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/** 保存节日装扮规则（写 campaign.holiday 任务的 params，带审计 + 热加载通知）。 */
export const saveHolidayRuleAction = defineAction({
  name: "admin.ops.holiday",
  auth: { admin: "site.admin" },
  input: holidayFormInput,
  async run(ctx, input) {
    const effects = asStringArray(input.itemEffect);
    const targets = asStringArray(input.itemTarget);
    // 固定 3 行：effect 留空 = 该行不使用；同名下标一一对应
    const items = effects
      .map((effect, index) => ({ effect, target: targets[index] ?? "" }))
      .filter((item) => item.effect !== "");
    const draft: Record<string, unknown> = {
      id: String(input.id),
      revision: String(input.revision),
      calendar: input.calendar,
      month: String(input.month),
      day: String(input.day),
      beforeDays: String(input.beforeDays),
      durationDays: String(input.durationDays),
      effects,
      targets,
    };
    const result = await updateOpsTask(
      input.id,
      input.revision,
      {
        params: {
          calendar: input.calendar,
          month: input.month,
          day: input.day,
          beforeDays: input.beforeDays,
          durationDays: input.durationDays,
          items,
        },
      },
      ctx.actor,
    );
    revalidatePath(OPS_PAGE);
    if (result.ok) redirect(`${OPS_PAGE}?holiday=saved`);
    if (result.code === "conflict") {
      // G-19：版本冲突 → 带草稿回表单，不静默换用最新版本
      holidayFail("holidayErr=conflict", draft);
    }
    holidayFail(
      `holidayErr=${encodeURIComponent(result.message ?? "规则保存失败，请重试")}`,
      draft,
    );
  },
});
