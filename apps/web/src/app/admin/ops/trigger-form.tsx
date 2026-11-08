import { SubmitButton } from "@/components/ui/submit-button";

import type { triggerBackupAction } from "./actions";

/** 手动备份按钮（defineAction 即 Server Action 引用；kind 由表单隐藏字段提供，提交后 redirect 反馈）。 */
export function TriggerBackupForm({ action }: { action: typeof triggerBackupAction }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <form action={action}>
        <input type="hidden" name="kind" value="db" />
        <SubmitButton>备份数据库</SubmitButton>
      </form>
      <form action={action}>
        <input type="hidden" name="kind" value="storage" />
        <SubmitButton>备份存储</SubmitButton>
      </form>
    </div>
  );
}
