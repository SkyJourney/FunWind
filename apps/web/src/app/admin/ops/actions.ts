"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { defineAction } from "@/lib/actions/define-action";
import { triggerOpsTask } from "@/lib/ops/client";
import { recordManualTrigger, setBackupRetention } from "@/lib/ops/tasks";

const BACKUP_TASKS = { db: "backup.db", storage: "backup.storage" } as const;

/**
 * 手动触发一次备份（M14：异步——运维任务管线受理后立即返回运行编号，执行进度见下方历史）。
 * 受理成功写审计（ops.task.run）；管线未部署 / 忙碌 / 降级时带说明重定向回本页。
 */
export const triggerBackupAction = defineAction({
  name: "admin.ops.backup",
  auth: { admin: "site.admin" },
  input: z.object({ kind: z.enum(["db", "storage"]) }),
  async run(ctx, input) {
    const taskKey = BACKUP_TASKS[input.kind];
    const result = await triggerOpsTask(taskKey);
    if (result.ok) await recordManualTrigger(taskKey, result.runId, ctx.actor);
    revalidatePath("/admin/ops");
    if (result.ok) redirect(`/admin/ops?backup=${input.kind}&queued=${result.runId}`);
    redirect(`/admin/ops?backup=${input.kind}&err=${encodeURIComponent(result.message)}`);
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
    revalidatePath("/admin/ops");
    if (result.ok) redirect("/admin/ops?policy=saved");
    redirect(`/admin/ops?err=${encodeURIComponent(result.message ?? "保留策略保存失败")}`);
  },
});
