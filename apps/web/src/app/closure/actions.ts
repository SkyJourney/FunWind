"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { defineAction } from "@/lib/actions/define-action";
import { redirectWithError } from "@/lib/actions/hop";
import {
  closureCancelIpRateLimit,
  closureConsumeIpRateLimit,
} from "@/lib/auth/rate-limit-policies";
import { hashEmailKey } from "@/lib/auth/tokens";
import {
  AccountDeletionError,
  cancelAccountDeletion,
  consumeAccountDeletionEmailToken,
  issueAccountDeletionAccessForEmail,
  issueAccountDeletionRequestForEmail,
  startOrOpenAccountDeletionWithPassword,
} from "@/lib/auth/account-deletion";
import {
  CLOSURE_ACCESS_COOKIE,
  clearClosureAccessCookie,
  setClosureAccessCookie,
  setSessionCookie,
} from "@/lib/auth/session";
import { accountDeletionVerificationMail, getMailBrand, trySendMail } from "@/lib/mail";

const identifierText = z.string().trim().min(1).max(254);
const passwordText = z.string().max(1024);
const emailText = z.string().trim().min(3).max(254);

/** 两类验证邮件共用发送与中性回跳，令牌用途和入口频控仍分别声明。 */
async function sendClosureEmail(email: string, kind: "access" | "request"): Promise<never> {
  const challenge =
    kind === "access"
      ? await issueAccountDeletionAccessForEmail(email)
      : await issueAccountDeletionRequestForEmail(email);
  if (challenge) {
    const brand = await getMailBrand();
    const url = `${brand.siteUrl}/closure/verify?token=${encodeURIComponent(challenge.token)}`;
    // 尽力而为：失败已进发送日志，页面提示保持中性，不泄露账号存在性。
    await trySendMail(challenge.email, accountDeletionVerificationMail(url, kind, brand));
  }
  redirect("/closure?sent=1");
}

export const startOrOpenClosureWithPasswordAction = defineAction({
  name: "account_deletion.start_or_open_password",
  auth: "guest",
  input: z.object({
    identifier: identifierText,
    current: passwordText,
    confirm: z.enum(["yes"]),
  }),
  rateLimit: [
    {
      key: (_ctx, input) =>
        `closure-access-identifier:${hashEmailKey(input.identifier.toLowerCase())}`,
      max: 5,
      windowMs: 60 * 60_000,
      onLimit: () => redirectWithError("/closure", "操作过于频繁，请稍后再试"),
    },
    {
      key: (ctx) => (ctx.ip ? `closure-access-ip:${ctx.ip}` : null),
      max: 10,
      windowMs: 60 * 60_000,
      onLimit: () => redirectWithError("/closure", "操作过于频繁，请稍后再试"),
    },
  ],
  async run(ctx, input) {
    try {
      const result = await startOrOpenAccountDeletionWithPassword(
        input.identifier,
        input.current,
        ctx.ip,
      );
      if (!result) redirectWithError("/closure", "无法验证账号，请检查登录名和密码");
      await setClosureAccessCookie(result.accessToken);
      redirect(result.started ? "/closure?requested=1" : "/closure");
    } catch (error) {
      if (error instanceof AccountDeletionError && error.code === "last_admin") {
        redirectWithError("/closure", "这是最后一位有效站点管理员，不能申请注销");
      }
      if (error instanceof AccountDeletionError && error.code === "already_completed") {
        redirectWithError("/closure", "该账号已完成注销");
      }
      throw error;
    }
  },
});

export const sendClosureAccessEmailAction = defineAction({
  name: "account_deletion.access_email",
  auth: "guest",
  input: z.object({ email: emailText }),
  rateLimit: [
    {
      key: (_ctx, input) => `closure-access-email:${hashEmailKey(input.email.toLowerCase())}`,
      max: 3,
      windowMs: 60 * 60_000,
      onLimit: () => redirect("/closure?sent=1"),
    },
    {
      key: (ctx) => (ctx.ip ? `closure-access-email-ip:${ctx.ip}` : null),
      max: 10,
      windowMs: 60 * 60_000,
      onLimit: () => redirect("/closure?sent=1"),
    },
  ],
  run: (_ctx, input) => sendClosureEmail(input.email, "access"),
});

export const sendClosureRequestEmailAction = defineAction({
  name: "account_deletion.request_email",
  auth: "guest",
  input: z.object({ email: emailText }),
  rateLimit: [
    {
      key: (_ctx, input) => `closure-request-email:${hashEmailKey(input.email.toLowerCase())}`,
      max: 3,
      windowMs: 60 * 60_000,
      onLimit: () => redirect("/closure?sent=1"),
    },
    {
      key: (ctx) => (ctx.ip ? `closure-request-email-ip:${ctx.ip}` : null),
      max: 10,
      windowMs: 60 * 60_000,
      onLimit: () => redirect("/closure?sent=1"),
    },
  ],
  run: (_ctx, input) => sendClosureEmail(input.email, "request"),
});

export const consumeClosureEmailTokenAction = defineAction({
  name: "account_deletion.consume_email_token",
  auth: "guest",
  input: z.object({ token: z.string().min(1).max(256) }),
  // 令牌本身高熵单次，爆破不可行；此限额防脚本高频打库
  rateLimit: [
    {
      key: (ctx) => closureConsumeIpRateLimit.key(ctx.ip),
      max: closureConsumeIpRateLimit.max,
      windowMs: closureConsumeIpRateLimit.windowMs,
      onLimit: () => redirectWithError("/closure/verify", "操作过于频繁，请稍后再试"),
    },
  ],
  async run(_ctx, input) {
    let result: Awaited<ReturnType<typeof consumeAccountDeletionEmailToken>>;
    try {
      result = await consumeAccountDeletionEmailToken(input.token);
    } catch (error) {
      if (error instanceof AccountDeletionError && error.code === "last_admin") {
        redirectWithError("/closure/verify", "这是最后一位有效站点管理员，不能申请注销");
      }
      throw error;
    }
    if (!result) redirectWithError("/closure/verify", "链接无效或已过期，请重新发起验证");
    await setClosureAccessCookie(result.accessToken);
    redirect("scheduledAt" in result ? "/closure?requested=1" : "/closure");
  },
});

export const cancelAccountDeletionAction = defineAction({
  name: "account_deletion.cancel",
  auth: "guest",
  rateLimit: [
    {
      key: (ctx) => closureCancelIpRateLimit.key(ctx.ip),
      max: closureCancelIpRateLimit.max,
      windowMs: closureCancelIpRateLimit.windowMs,
      onLimit: () => redirectWithError("/closure", "操作过于频繁，请稍后再试"),
    },
  ],
  async run(_ctx) {
    const token = (await cookies()).get(CLOSURE_ACCESS_COOKIE)?.value;
    if (!token) redirectWithError("/closure", "请先重新验证身份");
    try {
      const result = await cancelAccountDeletion(token);
      if (!result) redirectWithError("/closure", "请重新验证身份或注销状态已变化");
      await clearClosureAccessCookie();
      if (result.sessionToken) {
        await setSessionCookie(result.sessionToken);
        redirect("/settings?account-deletion=cancelled");
      }
      redirect("/appeal?accountDeletionCancelled=1");
    } catch (error) {
      if (error instanceof AccountDeletionError) {
        redirectWithError("/closure", "冷静期已结束，当前不能撤销申请");
      }
      throw error;
    }
  },
});
