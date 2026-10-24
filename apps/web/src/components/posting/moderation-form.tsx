import { Button } from "@/components/ui/button";

/**
 * 删除 / 恢复的确认表单（M6.2 第 5 步）。纯服务端组件：原生 `<form action>` 直接提交 Server Action，
 * 不需要草稿（理由很短，且确认页本身就是一次性的动作）。理由框的 required 不设置——服务端是权威校验，
 * 空理由会走 reason_required 分支跳回并显示固定文案。
 */
interface Props {
  action: (formData: FormData) => Promise<void>;
  postId: number;
  /** 是否显示理由输入框（版主操作、恢复必填） */
  reasonRequired: boolean;
  /** 确认按钮的文字 */
  submitLabel: string;
  /** 破坏性动作（删除）用红色按钮，恢复用默认按钮 */
  destructive?: boolean;
}

export function ModerationForm({
  action,
  postId,
  reasonRequired,
  submitLabel,
  destructive = false,
}: Props) {
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="postId" value={postId} />
      {reasonRequired && (
        <div className="space-y-1.5">
          <label htmlFor="moderation-reason" className="text-sm font-medium">
            理由（必填，写入审计记录）
          </label>
          <textarea
            id="moderation-reason"
            name="reason"
            rows={3}
            placeholder="例如：广告内容"
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </div>
      )}
      <Button type="submit" variant={destructive ? "destructive" : "default"}>
        {submitLabel}
      </Button>
    </form>
  );
}
