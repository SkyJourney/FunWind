import type { RegisterPolicy } from "@/lib/auth/register-policy";
import type { ActiveRegisterWindow } from "@/lib/campaigns/service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { saveRegisterPolicyAction } from "./actions";

/**
 * 注册策略卡片（M11.3；M11.4 Step 2 加窗口提示）。从站点配置页拆出的独立服务端组件
 * （文件行数棘轮只准缩小，见 scripts/check-duplication.mjs）。
 * 勾选框展示与保存写回的都是**站点原值**（policy）；窗口提示只读排期生效中的方案；
 * 「均已关闭」警示按生效值（registrationClosed，由调用方用 applyRegisterWindow 算好）判断——
 * 拆分原因见 M11.4 §2.2 F1：若给设置页读「生效值」，窗口期保存设置会把排期带来的「开」永久写进库。
 */
export function RegisterPolicyCard({
  policy,
  registerWindow,
  registrationClosed,
}: {
  policy: RegisterPolicy;
  registerWindow: ActiveRegisterWindow | null;
  registrationClosed: boolean;
}) {
  return (
    <Card id="register">
      <CardHeader>
        <CardTitle>注册策略</CardTitle>
      </CardHeader>
      <CardContent>
        {registerWindow && (
          <p
            role="status"
            data-testid="register-window-notice"
            className="mb-3 rounded-lg border bg-muted px-3 py-2 text-sm"
          >
            开放注册窗口生效中：「{registerWindow.name}」（至{" "}
            {registerWindow.endsAt ? registerWindow.endsAt.slice(0, 16) : "长期"}）。
            访客现在可凭邮箱注册、且须验证邮箱才能登录；窗口结束后回到下方设置，这里展示的始终是站点自己的设置。
          </p>
        )}
        {registrationClosed && (
          <p
            role="alert"
            data-testid="register-closed-warning"
            // 浅色下 --warning（amber-600）在 warning/10 底上只有 2.86:1，不达 AA；这里仅对本条警示局部加深（混黑 30%，约 5.3:1），
            // 深色沿用令牌（约 10:1）。--warning 是全站令牌（33 个文件 56 处使用），不在此处改动。
            className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-[color-mix(in_srgb,var(--warning)_70%,black)] dark:text-warning"
          >
            {
              "当前开放注册与邀请注册均已关闭：访客将看到「当前不开放注册」，无法创建新账号。已有账号的登录、找回密码与邮箱验证不受影响。"
            }
          </p>
        )}
        <form action={saveRegisterPolicyAction} className="space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              name="open"
              value="on"
              defaultChecked={policy.open}
              className="mt-1 size-4"
            />
            <span>
              <span className="font-medium">开放注册</span>
              <span className="text-muted-foreground">——任何人凭邮箱即可注册，无需邀请码</span>
            </span>
          </label>
          <label className="flex items-start gap-2 pl-6">
            <input
              type="checkbox"
              name="verifyEmail"
              value="on"
              defaultChecked={policy.verifyEmail}
              className="mt-1 size-4"
            />
            <span>
              <span className="font-medium">开放注册需验证邮箱</span>
              <span className="text-muted-foreground">
                ——开放注册的新账号必须先点邮件里的链接验证，否则无法登录；只对之后注册的账号生效，不影响已有账号
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              name="invite"
              value="on"
              defaultChecked={policy.invite}
              className="mt-1 size-4"
            />
            <span>
              <span className="font-medium">邀请注册</span>
              <span className="text-muted-foreground">
                ——持有效邀请码可注册（邀请码在「邀请码」页签发）。与开放注册同时开启时，邀请码选填；填了无效邀请码会直接报错，不会改走开放注册
              </span>
            </span>
          </label>
          <div>
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              保存注册策略
            </SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
