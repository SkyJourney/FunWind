import { resetPasswordAction } from "@/app/actions/auth";
import { AuthShell, Field, SubmitButton } from "../../ui-bits";

export const metadata = { title: "设置新密码" };

export default async function ResetPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  return (
    <AuthShell title="设置新密码" error={error}>
      <form action={resetPasswordAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <Field
          label="新密码（至少 8 位）"
          name="password"
          type="password"
          autoComplete="new-password"
        />
        <Field label="确认新密码" name="confirm" type="password" autoComplete="new-password" />
        <SubmitButton label="保存并登录" />
      </form>
    </AuthShell>
  );
}
