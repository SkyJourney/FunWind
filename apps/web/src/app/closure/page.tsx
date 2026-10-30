import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { SubmitButton } from "@/components/ui/submit-button";
import { getClosureAccess } from "@/lib/auth/session";
import {
  cancelAccountDeletionAction,
  sendClosureAccessEmailAction,
  sendClosureRequestEmailAction,
  startOrOpenClosureWithPasswordAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "注销申请状态", robots: { index: false, follow: false } };

export default async function ClosurePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string; requested?: string }>;
}) {
  const [access, params] = await Promise.all([getClosureAccess(), searchParams]);

  if (!access) {
    return (
      <main className="mx-auto max-w-xl space-y-4 px-4 py-10">
        <Card>
          <CardHeader>
            <h1 className="text-lg leading-none font-semibold">验证注销申请</h1>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              使用密码或已验证邮箱重新验证后，可查看申请状态或撤销。若账号尚无申请，密码或邮箱确认流程可发起
              30 天申请；验证凭据不会恢复普通登录权限。
            </p>
            {params.error && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
              >
                {params.error}
              </p>
            )}
            {params.sent === "1" && (
              <p
                role="status"
                className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-info"
              >
                如果该邮箱对应可验证的账号操作，验证链接已发送。
              </p>
            )}
            {params.requested === "1" && (
              <p
                role="status"
                className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-info"
              >
                已收到注销申请；所有普通会话已吊销。计划完成日期显示在下方。
              </p>
            )}
            <form action={startOrOpenClosureWithPasswordAction} className="space-y-3">
              <label className="block space-y-1">
                <span className="font-medium">用户名或邮箱</span>
                <input
                  name="identifier"
                  autoComplete="username"
                  required
                  maxLength={254}
                  className="w-full rounded-lg border bg-background px-3 py-2"
                />
              </label>
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
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input type="checkbox" name="confirm" value="yes" required className="mt-0.5" />
                <span>
                  我已阅读注销影响说明；若尚无申请，此操作会立即启动 30 天冷静期并吊销所有会话。
                </span>
              </label>
              <SubmitButton
                pendingText="验证中…"
                className="rounded-lg bg-primary px-4 py-2 text-primary-foreground"
              >
                验证状态或申请注销
              </SubmitButton>
            </form>
            <div className="border-t pt-4">
              <p className="mb-2 text-xs text-muted-foreground">
                没有密码的账号可通过已验证邮箱申请注销，或重新验证已有申请。
              </p>
              <form action={sendClosureAccessEmailAction} className="flex flex-wrap gap-2">
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  placeholder="已验证邮箱"
                  className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2"
                />
                <SubmitButton pendingText="发送中…" className="rounded-lg border px-3 py-2">
                  重新验证已有申请
                </SubmitButton>
              </form>
              <form action={sendClosureRequestEmailAction} className="mt-2 flex flex-wrap gap-2">
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  placeholder="已验证邮箱"
                  className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2"
                />
                <SubmitButton
                  pendingText="发送中…"
                  className="rounded-lg bg-primary px-3 py-2 text-primary-foreground"
                >
                  发送注销确认链接
                </SubmitButton>
              </form>
            </div>
            <Link href="/login" className="text-primary hover:underline">
              返回登录
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl space-y-4 px-4 py-10">
      <Card>
        <CardHeader>
          <h1 className="text-lg leading-none font-semibold">
            {access.status === "completed" ? "注销已完成" : "注销申请状态"}
          </h1>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {access.status === "completed" ? (
            <>
              <p>
                账号已按申请完成注销。公开主题、回帖和私信历史已保留并匿名化；此状态凭据不能用于登录或恢复账号。
              </p>
              <Link href="/" className="text-primary hover:underline">
                返回首页
              </Link>
            </>
          ) : (
            <>
              <p>
                注销申请处于 30 天冷静期，计划完成时间：<strong>{access.scheduledAt}</strong>。
              </p>
              <p className="text-muted-foreground">
                此专用页面只允许查看状态和撤销申请，不提供普通账号权限。
              </p>
              {access.canCancel ? (
                <form action={cancelAccountDeletionAction}>
                  <ConfirmSubmit
                    title="撤销注销申请"
                    description="确认撤销？系统会吊销注销专用访问并创建新会话；既有会话不会恢复，账号仍受其它有效限制约束。"
                    pendingText="撤销中…"
                    className="rounded-lg border border-destructive px-4 py-2 text-destructive"
                  >
                    撤销注销申请
                  </ConfirmSubmit>
                </form>
              ) : (
                <p
                  role="status"
                  className="rounded-lg border bg-muted px-3 py-2 text-muted-foreground"
                >
                  冷静期已结束，申请正在等待最终处理，已不能撤销。
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
