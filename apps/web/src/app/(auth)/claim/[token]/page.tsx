import { claimAction } from "@/app/actions/auth";
import { AuthShell, Field, SubmitButton } from "../../ui-bits";

export const metadata = { title: "认领老账号" };

export default async function ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  return (
    <AuthShell title="认领老账号" error={error}>
      <form action={claimAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <p className="text-sm text-muted-foreground">
          设置新密码后，你在老论坛的发帖、勋章、青翼币将全部回归。
        </p>
        <Field label="新密码（至少 8 位）" name="password" password autoComplete="new-password" />
        <Field label="确认新密码" name="confirm" password autoComplete="new-password" />
        <SubmitButton label="认领并登录" />
      </form>
    </AuthShell>
  );
}
