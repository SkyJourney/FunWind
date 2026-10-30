import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { submitAppealAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "账号申诉", robots: { index: false, follow: false } };

export default async function AppealPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; submitted?: string; accountDeletionCancelled?: string }>;
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams]);

  return (
    <main className="mx-auto max-w-xl space-y-4 px-4 py-10">
      <Card>
        <CardHeader>
          <h1 className="text-lg leading-none font-semibold">账号申诉</h1>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            申诉会提交给站点治理人员人工复核。请说明你认为限制有误或需要调整的原因；系统会对当前有效限制分别登记复核请求。
          </p>
          {!user && (
            <p className="rounded-lg border bg-muted px-3 py-2 text-muted-foreground">
              为确认申诉由本人提交，请使用用户名或邮箱和当前密码验证。没有密码的老账号可先通过{" "}
              <Link href="/forgot" className="text-primary underline">
                邮箱认领
              </Link>{" "}
              设置密码。
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
          {params.accountDeletionCancelled === "1" && (
            <p
              role="status"
              className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-info"
            >
              注销申请已撤销；账号仍受现有限制，重新验证后可提交人工复核。
            </p>
          )}
          {params.submitted === "1" && (
            <p
              role="status"
              className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-info"
            >
              已登记申诉；处理结果会通过站内通知或绑定邮箱告知。
            </p>
          )}
          <form action={submitAppealAction} className="space-y-3">
            {!user && (
              <>
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
              </>
            )}
            <label className="block space-y-1">
              <span className="font-medium">申诉理由</span>
              <textarea
                name="reason"
                required
                maxLength={2000}
                rows={6}
                className="w-full rounded-lg border bg-background px-3 py-2"
              />
            </label>
            <SubmitButton
              pendingText="提交中…"
              className="rounded-lg bg-primary px-4 py-2 text-primary-foreground"
            >
              提交人工复核
            </SubmitButton>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
