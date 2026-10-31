"use server";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { headers, cookies } from "next/headers";
import { getWebDb, users } from "@funwind/db";
import { findActiveGlobalBan } from "@/lib/authz/restrictions";
import { defineAction } from "@/lib/actions/define-action";
import { emit } from "@/modules/kernel/bus";
import type { EventName, EventPayloads } from "@/modules/kernel/types";
import { attemptLogin } from "@/lib/auth/login";
import { isValidEmail } from "@/lib/auth/email";
import { requestAccountEmail } from "@/lib/auth/forgot";
import { hashPassword } from "@/lib/auth/password";
import { checkUsername } from "@/lib/auth/username";
import { takeInviteAttempt } from "@/lib/auth/invite-limit";
import { InviteCodeError, RegisterError, registerUser } from "@/lib/auth/register";
import {
  clearClosureAccessCookie,
  createLegacyPasswordChangeSession,
  createSession,
  destroyCurrentSession,
  isSecureSite,
  replaceCredentialsAndCreateSessionWithEmailToken,
  SessionCreationError,
  setSessionCookie,
  MUST_CHANGE_COOKIE,
} from "@/lib/auth/session";
import { rateLimit } from "@/lib/auth/ratelimit";
import { issueEmailToken, peekEmailTokenUserId } from "@/lib/auth/tokens";
import { sendMail, verifyEmailMail } from "@/lib/auth/mailer";
import { getRegisterMode, getEmailVerificationMode } from "@/lib/auth/settings";
import { APP_URL } from "@/lib/site";

/**
 * 认证 Server Actions（M4）。
 * 防枚举：找回永远返回中性话术；登录失败统一「用户名或密码错误」；
 * 注册占用提示保留（社区惯例权衡，记录于 M4 文档）。
 *
 * 全部经 defineAction（M6.1）：求值模块注册表、取可信 IP 由骨架统一做。这些表单的业务文案与专用频控
 * （先占后退的登录桶、forgot / 邀请码的兜底桶）行为固定、已带变异验证，所以仍写在 run 里，不挪进声明式策略表。
 */

/**
 * 表单文本字段：缺失按空串（与迁移前 `String(formData.get(x) ?? "")` 一致，页面照常给出可读的业务提示），
 * 另设长度上限——超长一律 404，防巨型输入拖慢 argon2 / 查库。
 */
const text = (max: number) => z.string().max(max).default("");
const PASSWORD_MAX = 1024;

/** 派发领域事件：失败只记日志，绝不反噬登录/注册主流程（总线本身已隔离消费者异常，这里再兜一层） */
async function safeEmit<K extends EventName>(name: K, payload: EventPayloads[K]): Promise<void> {
  try {
    await emit(name, payload, { source: "auth" });
  } catch (e) {
    console.error(`[auth] ${name} 派发失败:`, e);
  }
}

async function redirectSessionCreationFailure(
  userId: number,
  code: SessionCreationError["code"],
): Promise<never> {
  if (code === "banned") {
    const ban = await findActiveGlobalBan(userId);
    if (ban) {
      const until = ban.endsAt ? `，至 ${ban.endsAt}` : "（永久）";
      redirect(
        "/login?error=" + encodeURIComponent(`账号已被封禁${until}：${ban.reason || "违规"}`),
      );
    }
  }
  redirect("/login?error=" + encodeURIComponent("账号状态已变化，请重新登录"));
}

async function establishLoginSession(
  userId: number,
  meta: { ip: string | null; userAgent: string },
  legacyPasswordChangeOnly = false,
): Promise<void> {
  try {
    if (legacyPasswordChangeOnly) await createLegacyPasswordChangeSession(userId, meta);
    else await createSession(userId, meta);
  } catch (error) {
    if (!(error instanceof SessionCreationError)) throw error;
    await redirectSessionCreationFailure(userId, error.code);
  }
}

/** reset / claim：令牌消费、凭据轮换、旧会话吊销与新会话签发共用一个事务。 */
async function establishEmailPasswordFlow(
  token: string,
  purpose: "reset" | "claim",
  password: string,
  meta: { ip: string | null; userAgent: string },
  options: {
    auditAction: "user.password.reset" | "user.password.claim";
    notice: "password-reset" | "claimed";
    requireUnsetPassword?: boolean;
  },
): Promise<never> {
  const tokenPath = purpose === "reset" ? "/reset/" : "/claim/";
  const invalidToken = () =>
    redirect(
      `${tokenPath}${encodeURIComponent(token)}?error=${encodeURIComponent("链接无效或已过期，请重新申请")}`,
    );
  if ((await peekEmailTokenUserId(token, purpose)) === null) invalidToken();

  const rotation = await replaceCredentialsAndCreateSessionWithEmailToken(
    token,
    purpose,
    await hashPassword(password),
    meta,
    { requireUnsetPassword: options.requireUnsetPassword, auditAction: options.auditAction },
  );
  if (!rotation.ok) {
    if (rotation.code === "invalid_token") return invalidToken();
    if (rotation.code === "already_claimed") {
      return redirect("/login?error=" + encodeURIComponent("该账号已设置过密码，请直接登录"));
    }
    return redirectSessionCreationFailure(rotation.userId, rotation.code);
  }
  await setSessionCookie(rotation.sessionToken);
  await clearClosureAccessCookie();
  await safeEmit("user.logged_in", { userId: rotation.userId });
  redirect(`/?notice=${options.notice}`);
}

/**
 * IP 级频控键；取不到可信 IP 时为 null。
 * 此时必须跳过 IP 级限额（见 lib/net/client-ip.ts：共享桶会被攻击者占满，反成全站登录的拒绝服务），
 * 只保留账号级/邮箱级限额。
 */
const ipRateKey = (prefix: string, ip: string | null): string | null =>
  ip === null ? null : `${prefix}:${ip}`;

/** IP 级限额检查：无可信 IP 时放行，由其余维度的限额兜底 */
const ipAllowed = (key: string | null, max: number, windowMs: number): boolean =>
  key === null || rateLimit(key, max, windowMs).allowed;

export const loginAction = defineAction({
  name: "auth.login",
  auth: "guest",
  input: z.object({ identifier: text(1024), password: text(PASSWORD_MAX) }),
  async run(ctx, input) {
    // 判定（含恒定工作量的校验与三层频控）见 lib/auth/login.ts
    const outcome = await attemptLogin({
      identifier: input.identifier,
      password: input.password,
      ip: ctx.ip,
    });
    if (!outcome.ok) {
      redirect(
        "/login?error=" +
          encodeURIComponent(
            outcome.reason === "throttled" ? "尝试过于频繁，请 10 分钟后再试" : "用户名或密码错误",
          ),
      );
    }
    const user = { id: outcome.userId, mustChange: outcome.mustChangePassword };

    // 全站封禁拦截（含理由与期限）
    const ban = await findActiveGlobalBan(user.id);
    if (ban) {
      const until = ban.endsAt ? `，至 ${ban.endsAt}` : "（永久）";
      redirect(
        "/login?error=" + encodeURIComponent(`账号已被封禁${until}：${ban.reason || "违规"}`),
      );
    }

    await destroyCurrentSession(); // 登录成功后先轮换当前设备 session，避免会话固定
    await establishLoginSession(
      user.id,
      { ip: ctx.ip, userAgent: (await headers()).get("user-agent") ?? "" },
      user.mustChange,
    );
    await getWebDb()
      .update(users)
      .set({ lastLoginAt: sql`NOW()` })
      .where(eq(users.id, user.id));
    if (user.mustChange) {
      // 仅作 middleware 快速跳转信号；普通页面/API 仍由数据库 legacy_password_pending 门控
      (await cookies()).set(MUST_CHANGE_COOKIE, "1", {
        httpOnly: true,
        sameSite: "lax",
        secure: isSecureSite(),
        path: "/",
        maxAge: 3600,
      });
    }
    await safeEmit("user.logged_in", { userId: user.id });
    redirect(user.mustChange ? "/settings/password?force=1" : "/");
  },
});

export const registerAction = defineAction({
  name: "auth.register",
  auth: "guest",
  input: z.object({
    username: text(200),
    email: text(320),
    password: text(PASSWORD_MAX),
    invite: text(200),
  }),
  async run(ctx, input) {
    const mode = await getRegisterMode();
    const username = input.username.trim();
    const email = input.email.trim().toLowerCase();
    const password = input.password;
    const invite = input.invite.trim();

    const fail = (msg: string): never => redirect(`/register?error=${encodeURIComponent(msg)}`);

    // IP 未知时开放注册退回全局兜底桶（宽松，仅防批量灌号）；邀请制有邀请码把关，不需要
    const registerIpKey = ipRateKey("register", ctx.ip);
    if (
      !ipAllowed(registerIpKey, 5, 60 * 60_000) ||
      (registerIpKey === null &&
        mode === "open" &&
        !rateLimit("register-global", 60, 60 * 60_000).allowed)
    ) {
      fail("注册过于频繁，请稍后再试");
    }
    const nameCheck = checkUsername(username);
    if (!nameCheck.ok) fail(nameCheck.message);
    if (!isValidEmail(email)) fail("邮箱格式不正确");
    if (password.length < 8) fail("密码至少 8 位");

    // 邀请制：邀请码是唯一门槛，猜测单独限速（先占后退，只有邀请码无效才留下计数）
    const inviteAttempt = mode === "invite" ? takeInviteAttempt(ctx.ip) : null;
    if (inviteAttempt && !inviteAttempt.allowed) fail("邀请码尝试过于频繁，请稍后再试");

    const passwordHash = await hashPassword(password);
    const verificationMode = await getEmailVerificationMode();
    const requiresEmailVerification = mode === "open" || verificationMode === "always";

    let newId: number;
    try {
      newId = await registerUser({
        username,
        email,
        passwordHash,
        emailVerificationRequired: requiresEmailVerification,
        invite: mode === "invite" ? invite : null,
      });
    } catch (e) {
      if (e instanceof RegisterError) {
        if (!(e instanceof InviteCodeError)) inviteAttempt?.refund(); // 与邀请码无关的失败不计入
        return fail(e.message);
      }
      inviteAttempt?.refund();
      throw e;
    }
    inviteAttempt?.refund();

    // 邮箱验证要求已写入用户行；注册模式后续切换不会改变该账号的写权限门。
    if (requiresEmailVerification) {
      const token = await issueEmailToken(newId, "verify", email);
      const { getSiteIdentity } = await import("@/lib/site-chrome");
      const identity = await getSiteIdentity().catch(() => undefined);
      await sendMail(
        email,
        verifyEmailMail(`${identity?.url ?? APP_URL}/verify/${token}`, identity?.name),
      );
    }

    await establishLoginSession(newId, {
      ip: ctx.ip,
      userAgent: (await headers()).get("user-agent") ?? "",
    });
    await safeEmit("user.registered", { userId: newId });
    redirect(requiresEmailVerification ? "/?notice=verify-email-sent" : "/");
  },
});

export const forgotAction = defineAction({
  name: "auth.forgot",
  auth: "guest",
  input: z.object({ email: text(320) }),
  async run(ctx, input) {
    // 判定与限额见 lib/auth/forgot.ts；无论结果如何都跳到同一个中性视图，响应时间也与邮箱是否存在无关
    await requestAccountEmail(input.email, ctx.ip, { defer: (task) => after(task) });
    redirect("/forgot?sent=1");
  },
});

export const resetPasswordAction = defineAction({
  name: "auth.reset",
  auth: "guest",
  input: z.object({ token: text(256), password: text(PASSWORD_MAX), confirm: text(PASSWORD_MAX) }),
  async run(ctx, { token, password, confirm }) {
    if (password.length < 8) {
      redirect(
        "/reset/" + encodeURIComponent(token) + "?error=" + encodeURIComponent("密码至少 8 位"),
      );
    }
    if (password !== confirm) {
      redirect(
        "/reset/" +
          encodeURIComponent(token) +
          "?error=" +
          encodeURIComponent("两次输入的密码不一致"),
      );
    }

    return establishEmailPasswordFlow(
      token,
      "reset",
      password,
      { ip: ctx.ip, userAgent: (await headers()).get("user-agent") ?? "" },
      { auditAction: "user.password.reset", notice: "password-reset" },
    );
  },
});

export const claimAction = defineAction({
  name: "auth.claim",
  auth: "guest",
  input: z.object({ token: text(256), password: text(PASSWORD_MAX), confirm: text(PASSWORD_MAX) }),
  async run(ctx, { token, password, confirm }) {
    if (password.length < 8) {
      redirect(
        "/claim/" + encodeURIComponent(token) + "?error=" + encodeURIComponent("密码至少 8 位"),
      );
    }
    if (password !== confirm) {
      redirect(
        "/claim/" +
          encodeURIComponent(token) +
          "?error=" +
          encodeURIComponent("两次输入的密码不一致"),
      );
    }

    return establishEmailPasswordFlow(
      token,
      "claim",
      password,
      { ip: ctx.ip, userAgent: (await headers()).get("user-agent") ?? "" },
      {
        requireUnsetPassword: true,
        auditAction: "user.password.claim",
        notice: "claimed",
      },
    );
  },
});

/** 邮箱验证确认（/verify/{token} 页面的按钮）：POST 才消费令牌，见该页注释 */
export const verifyEmailAction = defineAction({
  name: "auth.verify-email",
  auth: "guest",
  input: z.object({ token: text(256) }),
  async run(_ctx, { token }) {
    const { consumeEmailToken } = await import("@/lib/auth/tokens");
    const userId = await consumeEmailToken(token, "verify");
    if (userId === null) {
      redirect("/login?error=" + encodeURIComponent("验证链接无效或已过期"));
    }
    redirect("/login?message=" + encodeURIComponent("邮箱验证完成，请登录"));
  },
});

export const logoutAction = defineAction({
  name: "auth.logout",
  auth: "guest",
  async run() {
    await destroyCurrentSession();
    (await cookies()).delete(MUST_CHANGE_COOKIE);
    redirect("/");
  },
});
