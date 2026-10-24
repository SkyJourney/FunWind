import { verifyEmailAction } from "@/app/actions/auth";
import { AuthShell, SubmitButton } from "../../ui-bits";

export const metadata = {
  title: "验证邮箱",
  // 链接里带令牌：不被索引，也不经 Referer 泄露给页面上的外链
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

/**
 * 邮箱验证确认页（M5.6 S3）。
 * 以前 GET /verify/{token} 直接消费令牌：邮件安全扫描器（SafeLinks 等）和链接预览会预取邮件里的链接，
 * 把令牌提前消费掉，用户点开却提示「无效」。现在 GET 只渲染页面（不查库、不消费），必须点按钮 POST 才消费。
 */
export default async function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthShell title="验证邮箱">
      <form action={verifyEmailAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <p className="text-sm text-muted-foreground">点击下方按钮，完成邮箱验证。</p>
        <SubmitButton label="确认验证邮箱" />
      </form>
    </AuthShell>
  );
}
