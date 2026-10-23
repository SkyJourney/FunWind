import Link from "next/link";
import { loginAction } from "@/app/actions/auth";
import { AuthShell, Field, SubmitButton } from "../ui-bits";

export const metadata = { title: "登录" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { error, message } = await searchParams;
  return (
    <AuthShell
      title="登录"
      error={error}
      message={message}
      footer={
        <>
          没有账号？
          <Link className="text-primary hover:underline" href="/register">
            注册
          </Link>
          {" · "}
          <Link className="text-primary hover:underline" href="/forgot">
            忘记密码
          </Link>
          {" · "}
          <Link className="text-primary hover:underline" href="/claim">
            认领老账号
          </Link>
        </>
      }
    >
      <form action={loginAction} className="space-y-4">
        <Field label="用户名或邮箱" name="identifier" autoComplete="username" />
        <Field label="密码" name="password" type="password" autoComplete="current-password" />
        <SubmitButton label="登录" />
      </form>
    </AuthShell>
  );
}
