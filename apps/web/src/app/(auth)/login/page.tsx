import Link from "next/link";
import { loginAction, resendVerificationAction } from "@/app/actions/auth";
import { AuthShell, Field, SubmitButton } from "../ui-bits";

export const metadata = { title: "登录" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; unverified?: string; resent?: string }>;
}) {
  const { error, message, unverified, resent } = await searchParams;
  // 登录门拦下（unverified）或刚重发过（resent）时显示重发表单；重发后保留表单，冷却期过后可再次申请
  const showResend = unverified === "1" || resent === "1";
  return (
    <AuthShell
      title="登录"
      error={error}
      message={
        resent === "1" ? "若该邮箱有待验证的账号，验证邮件已发出（请检查垃圾箱）。" : message
      }
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
          {" · "}
          <Link className="text-primary hover:underline" href="/appeal">
            账号申诉
          </Link>
          {" · "}
          <Link className="text-primary hover:underline" href="/closure">
            注销申请
          </Link>
        </>
      }
    >
      <form action={loginAction} className="space-y-4">
        <Field label="用户名或邮箱" name="identifier" autoComplete="username" />
        <Field label="密码" name="password" password autoComplete="current-password" />
        <SubmitButton label="登录" />
      </form>
      {showResend && (
        <form
          action={resendVerificationAction}
          data-testid="resend-verification"
          className="mt-6 space-y-3 border-t pt-4"
        >
          <p className="text-sm text-muted-foreground">
            没收到验证邮件？输入注册邮箱，我们会重新发送（2 分钟内只能申请一次）。
          </p>
          <Field label="注册邮箱" name="email" type="email" autoComplete="email" />
          <SubmitButton label="重新发送验证邮件" />
        </form>
      )}
    </AuthShell>
  );
}
