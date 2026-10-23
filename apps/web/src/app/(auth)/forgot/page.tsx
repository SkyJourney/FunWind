import Link from "next/link";
import { forgotAction } from "@/app/actions/auth";
import { AuthShell, Field, SubmitButton } from "../ui-bits";

export const metadata = { title: "找回密码" };

export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;
  return (
    <AuthShell
      title="找回密码 / 认领账号"
      message={sent ? "若该邮箱已注册，邮件已发出（请检查垃圾箱）。" : undefined}
      footer={
        <Link className="text-primary hover:underline" href="/login">
          返回登录
        </Link>
      }
    >
      <form action={forgotAction} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          输入注册邮箱：老账号（旧密码不可迁移）会收到「认领」邮件；已设密账号收到「重置」邮件。
        </p>
        <Field label="注册邮箱" name="email" type="email" autoComplete="email" />
        <SubmitButton label="发送邮件" />
      </form>
    </AuthShell>
  );
}
