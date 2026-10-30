import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  requestAccountDeletionWithPasswordAction,
  sendAccountDeletionRequestEmailAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "注销账号" };

export default async function DeleteAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) return null;
  const params = await searchParams;
  const passwordRequired = user.passwordHashIsSet;

  return (
    <Card>
      <CardHeader>
        <CardTitle>申请注销账号</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-2 text-muted-foreground">
          <p>
            提交后会进入 30
            天冷静期。期间你的公开内容和身份保持原样，但不能继续发帖、互动或修改资料。
          </p>
          <p>
            申请会立即退出所有设备。本人重新验证后可查看截止时间或撤销；撤销后会建立新会话，旧会话不会恢复。
          </p>
          <p>
            冷静期结束后，主题、回帖和私信历史会保留并匿名化；关注、偏好、角色、限制和徽章展示会清理。积分台账与治理审计作为匿名历史保留。此流程不提供数据导出。
          </p>
        </div>

        {params.sent === "1" && (
          <p
            role="status"
            className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-info"
          >
            如果该账号符合邮箱确认条件，确认邮件已发送；请从邮件中的链接继续。
          </p>
        )}
        {params.error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
          >
            {params.error}
          </p>
        )}

        {passwordRequired ? (
          <form action={requestAccountDeletionWithPasswordAction} className="space-y-3">
            <label className="block space-y-1">
              <span className="font-medium">当前密码</span>
              <input
                name="current"
                type="password"
                autoComplete="current-password"
                required
                maxLength={1024}
                className="w-full rounded-lg border bg-background px-3 py-2"
              />
            </label>
            <SubmitButton
              pendingText="提交中…"
              className="rounded-lg bg-destructive px-4 py-2 text-destructive-foreground"
            >
              确认申请注销
            </SubmitButton>
          </form>
        ) : user.emailVerified ? (
          <form action={sendAccountDeletionRequestEmailAction}>
            <SubmitButton
              pendingText="发送中…"
              className="rounded-lg bg-destructive px-4 py-2 text-destructive-foreground"
            >
              向已验证邮箱发送确认链接
            </SubmitButton>
          </form>
        ) : (
          <p className="rounded-lg border bg-muted px-3 py-2 text-muted-foreground">
            此账号尚无可用密码且邮箱未验证。请先到{" "}
            <Link className="text-primary underline" href="/settings/email">
              邮箱设置
            </Link>{" "}
            完成邮箱验证，再申请注销。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
