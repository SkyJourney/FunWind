import Link from "next/link";
import { registerAction } from "@/app/actions/auth";
import { getRegisterPolicy } from "@/lib/auth/settings";
import { registerAvailability, type RegisterPolicy } from "@/lib/auth/register-policy";
import { AuthShell, Field, SubmitButton } from "../ui-bits";

export const dynamic = "force-dynamic";
export const metadata = { title: "注册" };

const footer = (
  <>
    已有账号？
    <Link className="text-primary hover:underline" href="/login">
      登录
    </Link>
  </>
);

/** 表单底部说明：让访客在提交前就知道自己走的是哪条路径、之后要不要验证邮箱 */
function modeNote(kind: "invite-only" | "open-only" | "both", policy: RegisterPolicy): string {
  const verifyNote = "注册后需先验证邮箱才能登录。";
  if (kind === "invite-only") return "当前注册方式：邀请制。";
  if (kind === "open-only")
    return `当前注册方式：开放注册。${policy.verifyEmail ? verifyNote : ""}`;
  // 双开：有邀请码按邀请注册；留空即开放注册，只有留空这条路径会被要求验证邮箱
  return `当前注册方式：开放注册或邀请注册。有邀请码请填写，没有可留空。${
    policy.verifyEmail ? `不填邀请码时，${verifyNote}` : ""
  }`;
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const policy = await getRegisterPolicy();
  const availability = registerAvailability(policy);

  // 两个开关都关：不渲染表单。登录、找回密码等入口不受影响，页脚仍给出登录链接。
  if (availability.kind === "closed") {
    return (
      <AuthShell title="注册" error={error} footer={footer}>
        <p data-testid="register-closed" className="text-center text-sm text-muted-foreground">
          当前不开放注册。如需加入，请联系站点管理员获取邀请。
        </p>
      </AuthShell>
    );
  }

  const showInvite = availability.kind !== "open-only";
  const inviteRequired = availability.kind === "invite-only";

  return (
    <AuthShell title="注册" error={error} footer={footer}>
      <form action={registerAction} className="space-y-4">
        {showInvite && (
          <Field
            label={inviteRequired ? "邀请码" : "邀请码（选填）"}
            name="invite"
            placeholder="老用户召回 / 站方发放"
            required={inviteRequired}
          />
        )}
        <Field label="用户名" name="username" placeholder="2-20 位（中文/字母/数字/下划线）" />
        <Field label="邮箱" name="email" type="email" autoComplete="email" />
        <Field label="密码（至少 8 位）" name="password" password autoComplete="new-password" />
        <SubmitButton label={inviteRequired ? "凭邀请码注册" : "注册"} />
        <p className="text-center text-xs text-muted-foreground">
          {modeNote(availability.kind, policy)}
        </p>
      </form>
    </AuthShell>
  );
}
