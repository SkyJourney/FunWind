"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { defineAction } from "@/lib/actions/define-action";
import {
  issueAccountDeletionEmailToken,
  requestAccountDeletionWithPassword,
  AccountDeletionError,
} from "@/lib/auth/account-deletion";
import { destroyCurrentSession, setClosureAccessCookie } from "@/lib/auth/session";
import { rateLimit } from "@/lib/auth/ratelimit";
import { getCurrentUser } from "@/lib/auth/session";
import { accountDeletionVerificationMail, sendMail } from "@/lib/auth/mailer";
import { getSiteIdentity } from "@/lib/site-chrome";
import { APP_URL } from "@/lib/site";

const passwordText = z.string().max(1024).default("");

function errorText(error: unknown): string {
  if (!(error instanceof AccountDeletionError)) return "暂时无法提交申请，请稍后重试。";
  switch (error.code) {
    case "password_required":
    case "password_invalid":
      return "当前密码不正确，请重新验证。";
    case "email_unverified":
      return "请先验证已绑定邮箱。";
    case "already_pending":
      return "当前已有一条注销申请。";
    case "already_completed":
      return "该账号已完成注销，不能再次申请。";
    case "last_admin":
      return "这是最后一位有效站点管理员，不能申请注销。请先由另一位管理员接任。";
    default:
      return "账号当前无法申请注销，请检查账号状态后重试。";
  }
}

export const requestAccountDeletionWithPasswordAction = defineAction({
  name: "settings.account_deletion.request_password",
  auth: "user",
  input: z.object({ current: passwordText }),
  rateLimit: [
    {
      key: (ctx) => (ctx.userId === null ? null : `account-deletion:${ctx.userId}`),
      max: 3,
      windowMs: 60 * 60_000,
      onLimit: () => redirect("/settings/delete-account?error=操作过于频繁，请稍后再试"),
    },
  ],
  async run(ctx, input) {
    const user = await getCurrentUser();
    if (!user || user.id !== ctx.userId) redirect("/login");
    try {
      const result = await requestAccountDeletionWithPassword(
        { userId: user.id, ip: ctx.ip },
        input.current,
      );
      await destroyCurrentSession();
      await setClosureAccessCookie(result.accessToken);
      redirect("/closure");
    } catch (error) {
      if (error instanceof AccountDeletionError) {
        redirect(`/settings/delete-account?error=${encodeURIComponent(errorText(error))}`);
      }
      throw error;
    }
  },
});

export const sendAccountDeletionRequestEmailAction = defineAction({
  name: "settings.account_deletion.request_email",
  auth: "user",
  async run(ctx) {
    const user = await getCurrentUser();
    if (!user || user.id !== ctx.userId) redirect("/login");
    if (!rateLimit(`account-deletion-email:${user.id}`, 3, 60 * 60_000).allowed) {
      redirect("/settings/delete-account?error=邮件发送过于频繁，请稍后再试");
    }

    let challenge: Awaited<ReturnType<typeof issueAccountDeletionEmailToken>>;
    try {
      challenge = await issueAccountDeletionEmailToken(user.id, "request");
    } catch (error) {
      if (error instanceof AccountDeletionError) {
        redirect(`/settings/delete-account?error=${encodeURIComponent(errorText(error))}`);
      }
      redirect("/settings/delete-account?error=暂时无法发送确认邮件");
    }
    if (!challenge) redirect("/settings/delete-account?sent=1");

    const identity = await getSiteIdentity().catch(() => undefined);
    const url = `${identity?.url ?? APP_URL}/closure/verify?token=${encodeURIComponent(challenge.token)}`;
    try {
      await sendMail(
        challenge.email,
        accountDeletionVerificationMail(url, "request", identity?.name),
      );
    } catch {
      redirect("/settings/delete-account?error=邮件发送失败，请稍后重试");
    }
    redirect("/settings/delete-account?sent=1");
  },
});
