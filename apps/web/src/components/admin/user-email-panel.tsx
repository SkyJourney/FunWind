import { ActionGroup } from "@/components/ui/action-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";

/**
 * 用户详情页「邮箱与验证」卡片（M11.3 清账）。
 *
 * 为什么放在后台：用户注册时填错邮箱，登录门会把他挡在外面，免登录重发又发回同一个错地址，
 * 自己无法解开。管理员在这里改成正确邮箱并重新发起验证，用户点新地址里的链接后才能登录。
 * 不提供「手动标记已验证」：站长明确要求用户重走验证流程。
 */

export type EmailPanelDetail = {
  id: number;
  email: string | null;
  emailVerifiedAt: string | null;
  emailVerificationRequired: boolean;
  /** 登录验证门：true = 注册后一直没验证，无法登录 */
  loginVerificationRequired: boolean;
};

export type EmailStatusTone = "success" | "warning" | "muted";

/** 邮箱验证状态的展示：文案与色调；纯函数，便于单测覆盖每个分支 */
export function describeEmailVerification(d: EmailPanelDetail): {
  label: string;
  tone: EmailStatusTone;
} {
  if (d.emailVerifiedAt) return { label: "邮箱已验证", tone: "success" };
  if (d.loginVerificationRequired) return { label: "注册后未验证，无法登录", tone: "warning" };
  if (d.emailVerificationRequired) return { label: "邮箱待验证（写入受限）", tone: "warning" };
  return { label: "邮箱未验证（账号未要求验证）", tone: "warning" };
}

const TONE_CLS: Record<EmailStatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

const inputCls =
  "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

export function UserEmailPanel({
  detail,
  canEdit,
  action,
}: {
  detail: EmailPanelDetail;
  /** 已注销 / 注销冷静期的账号只读：不显示改邮箱表单 */
  canEdit: boolean;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const status = describeEmailVerification(detail);
  return (
    <Card id="email" data-testid="user-email-panel">
      <CardHeader>
        <CardTitle>邮箱与验证</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <span data-testid="user-email-current" className="min-w-0 [overflow-wrap:anywhere]">
            {detail.email ?? "（无邮箱）"}
          </span>
          <span data-testid="user-email-status" className={TONE_CLS[status.tone]}>
            {status.label}
          </span>
        </div>
        {canEdit && (
          <form action={action} className="space-y-2">
            <input type="hidden" name="userId" value={detail.id} />
            {/* 标签持有首选宽度、输入框跟随标签：固定宽度的输入框会把窄屏撑出视口（M11.3 目视验收教训） */}
            <label className="grid w-96 max-w-full min-w-0 gap-1">
              新邮箱
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="off"
                className={inputCls}
              />
            </label>
            <ActionGroup>
              <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                修改邮箱并发送验证邮件
              </SubmitButton>
              <span className="min-w-0 text-xs [overflow-wrap:anywhere] text-muted-foreground">
                用户需要重新验证新邮箱。已验证的账号在验证完成前回到写权限受限；注册后一直未验证的账号，验证完成前仍无法登录。操作会记入审计日志。
              </span>
            </ActionGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
