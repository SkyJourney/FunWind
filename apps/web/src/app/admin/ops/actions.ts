"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { defineAction } from "@/lib/actions/define-action";
import { setBackupPolicy, triggerBackup } from "@/lib/ops/backup";

/**
 * 手动触发一次备份（备份服务执行，后台只是管理入口；M13 追加运维功能）。
 * kind: db（mysqldump 全备）/ storage（源存储 tar 全备）。
 * 未部署备份服务时重带回提示（本地开发常态），不报错。
 */
export const triggerBackupAction = defineAction({
  name: "admin.ops.backup",
  auth: { admin: "site.admin" },
  input: z.object({ kind: z.enum(["db", "storage"]) }),
  async run(_ctx, input) {
    const result = await triggerBackup(input.kind);
    revalidatePath("/admin/ops");
    if (result.ok) {
      redirect(`/admin/ops?backup=${input.kind}&done=1`);
    }
    const message =
      result.code === "unconfigured"
        ? "备份服务未部署（BACKUP_SERVICE_URL / BACKUP_OPS_TOKEN 未配置），定时备份仍由宿主机 crontab 承担"
        : result.code === "busy"
          ? "已有备份/恢复任务在执行，稍后再试"
          : result.message;
    redirect(`/admin/ops?backup=${input.kind}&err=${encodeURIComponent(message)}`);
  },
});

const backupPolicyInput = z.object({
  keepDb: z.coerce.number().int().min(1).max(90),
  keepStorage: z.coerce.number().int().min(1).max(90),
});

/** 保存备份保留策略（份数；备份服务每次执行时动态读取，保存即生效）。 */
export const saveBackupPolicyAction = defineAction({
  name: "admin.ops.policy",
  auth: { admin: "site.admin" },
  input: backupPolicyInput,
  async run(_ctx, input) {
    await setBackupPolicy({ keepDb: input.keepDb, keepStorage: input.keepStorage });
    revalidatePath("/admin/ops");
    redirect("/admin/ops?policy=saved");
  },
});
