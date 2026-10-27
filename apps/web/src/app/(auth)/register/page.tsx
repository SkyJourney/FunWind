import Link from "next/link";
import { registerAction } from "@/app/actions/auth";
import { getRegisterMode } from "@/lib/auth/settings";
import { AuthShell, Field, SubmitButton } from "../ui-bits";

export const dynamic = "force-dynamic";
export const metadata = { title: "注册" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const mode = await getRegisterMode();

  return (
    <AuthShell
      title="注册"
      error={error}
      footer={
        <>
          已有账号？
          <Link className="text-primary hover:underline" href="/login">
            登录
          </Link>
        </>
      }
    >
      <form action={registerAction} className="space-y-4">
        {mode === "invite" && (
          <Field label="邀请码" name="invite" placeholder="老用户召回 / 站方发放" />
        )}
        <Field label="用户名" name="username" placeholder="2-20 位（中文/字母/数字/下划线）" />
        <Field label="邮箱" name="email" type="email" autoComplete="email" />
        <Field label="密码（至少 8 位）" name="password" password autoComplete="new-password" />
        <SubmitButton label={mode === "invite" ? "凭邀请码注册" : "注册"} />
        <p className="text-center text-xs text-muted-foreground">
          当前注册方式：{mode === "invite" ? "邀请制" : "开放注册（需邮箱验证）"}
        </p>
      </form>
    </AuthShell>
  );
}
