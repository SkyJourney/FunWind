"use server";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { headers } from "next/headers";
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
import { createSession, destroyCurrentSession, revokeAllForUser } from "@/lib/auth/session";
import { rateLimit } from "@/lib/auth/ratelimit";
import { issueEmailToken } from "@/lib/auth/tokens";
import { sendMail, verifyEmailMail } from "@/lib/auth/mailer";
import { getRegisterMode } from "@/lib/auth/settings";

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
    const user = { id: outcome.userId };

    // 全站封禁拦截（含理由与期限）
    const ban = await findActiveGlobalBan(user.id);
    if (ban) {
      const until = ban.endsAt ? `，至 ${ban.endsAt}` : "（永久）";
      redirect(
        "/login?error=" + encodeURIComponent(`账号已被封禁${until}：${ban.reason || "违规"}`),
      );
    }

    await getWebDb()
      .update(users)
      .set({ lastLoginAt: sql`NOW()` })
      .where(eq(users.id, user.id));
    await createSession(user.id, {
      ip: ctx.ip,
      userAgent: (await headers()).get("user-agent") ?? "",
    });
    await safeEmit("user.logged_in", { userId: user.id });
    redirect("/");
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

    let newId: number;
    try {
      newId = await registerUser({
        username,
        email,
        passwordHash,
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

    if (mode === "open") {
      // 开放注册：邮箱验证令牌（验证前可登录、可浏览，写类权限由评估器拦截）
      const token = await issueEmailToken(newId, "verify");
      const { APP_URL: appUrl } = await import("@/lib/site");
      const { getSiteIdentity } = await import("@/lib/site-chrome");
      const siteName = await getSiteIdentity()
        .then((i) => i.name)
        .catch(() => undefined);
      await sendMail(email, verifyEmailMail(`${appUrl}/verify/${token}`, siteName));
    }

    await createSession(newId, {
      ip: ctx.ip,
      userAgent: (await headers()).get("user-agent") ?? "",
    });
    await safeEmit("user.registered", { userId: newId });
    redirect(mode === "invite" ? "/" : "/?notice=verify-email-sent");
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
  async run(_ctx, { token, password, confirm }) {
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

    const { consumeEmailToken } = await import("@/lib/auth/tokens");
    const userId = await consumeEmailToken(token, "reset");
    if (userId === null) {
      redirect(
        "/reset/" +
          encodeURIComponent(token) +
          "?error=" +
          encodeURIComponent("链接无效或已过期，请重新申请"),
      );
    }

    const db = getWebDb();
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, userId));
    await revokeAllForUser(userId);
    redirect("/login?message=" + encodeURIComponent("密码已重置，请用新密码登录"));
  },
});

export const claimAction = defineAction({
  name: "auth.claim",
  auth: "guest",
  input: z.object({ token: text(256), password: text(PASSWORD_MAX), confirm: text(PASSWORD_MAX) }),
  async run(_ctx, { token, password, confirm }) {
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

    const { consumeEmailToken } = await import("@/lib/auth/tokens");
    const userId = await consumeEmailToken(token, "claim");
    if (userId === null) {
      redirect(
        "/claim/" +
          encodeURIComponent(token) +
          "?error=" +
          encodeURIComponent("链接无效或已过期，请重新申请"),
      );
    }

    const db = getWebDb();
    const rows = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (rows[0]?.passwordHash) {
      redirect("/login?error=" + encodeURIComponent("该账号已设置过密码，请直接登录"));
    }

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, userId));
    await revokeAllForUser(userId);
    redirect("/login?message=" + encodeURIComponent("账号认领成功，请登录"));
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
    redirect("/");
  },
});
