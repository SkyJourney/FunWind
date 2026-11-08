import { SubmitButton } from "@/components/ui/submit-button";

import type { saveBackupPolicyAction } from "./actions";

/** 备份保留策略表单（份数 1–90；保存后写入 site_settings，备份服务轮转时动态读取）。 */
export function PolicyForm({
  action,
  keepDb,
  keepStorage,
}: {
  action: typeof saveBackupPolicyAction;
  keepDb: number;
  keepStorage: number;
}) {
  return (
    <form action={action} className="mt-3 flex flex-wrap items-end gap-4">
      <label className="text-sm">
        数据库备份保留
        <input
          type="number"
          name="keepDb"
          min={1}
          max={90}
          defaultValue={keepDb}
          className="mt-1 block w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
        />
        份
      </label>
      <label className="text-sm">
        存储备份保留
        <input
          type="number"
          name="keepStorage"
          min={1}
          max={90}
          defaultValue={keepStorage}
          className="mt-1 block w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
        />
        份
      </label>
      <SubmitButton>保存策略</SubmitButton>
    </form>
  );
}
