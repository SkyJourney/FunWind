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
          {/* 认领入口就是找回页：输入邮箱，老账号（无密码）会收到「认领」邮件。/claim 只有带令牌的子路由，不能直接访问 */}
          <Link className="text-primary hover:underline" href="/forgot">
            忘记密码 / 认领老账号
          </Link>
        </>
      }
    >
      <form action={loginAction} className="space-y-4">
        <Field label="用户名或邮箱" name="identifier" autoComplete="username" />
        <Field label="密码" name="password" password autoComplete="current-password" />
        <SubmitButton label="登录" />
      </form>
    </AuthShell>
  );
}
