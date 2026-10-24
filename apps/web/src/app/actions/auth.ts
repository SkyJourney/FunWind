"use server";

import { and, eq, or, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getWebDb, normalizeKey, users } from "@funwind/db";
import { findActiveGlobalBan } from "@/lib/authz/restrictions";
import { clientIpFrom } from "@/lib/net/client-ip";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { RegisterError, registerUser } from "@/lib/auth/register";
import { createSession, destroyCurrentSession, revokeAllForUser } from "@/lib/auth/session";
import { rateLimit } from "@/lib/auth/ratelimit";
import { issueEmailToken } from "@/lib/auth/tokens";
import { claimMail, resetPasswordMail, sendMail, verifyEmailMail } from "@/lib/auth/mailer";
import { getRegisterMode } from "@/lib/auth/settings";

/**
 * 认证 Server Actions（M4）。
 * 防枚举：找回永远返回中性话术；登录失败统一「用户名或密码错误」；
 * 注册占用提示保留（社区惯例权衡，记录于 M4 文档）。
 */

const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * IP 级频控键；取不到可信 IP 时为 null。
 * 此时必须跳过 IP 级限额（见 lib/net/client-ip.ts：共享桶会被攻击者占满，反成全站登录的拒绝服务），
 * 只保留账号级/邮箱级限额。
 */
async function ipRateKey(prefix: string): Promise<string | null> {
  const ip = clientIpFrom(await headers());
  return ip === null ? null : `${prefix}:${ip}`;
}

/** IP 级限额检查：无可信 IP 时放行，由其余维度的限额兜底 */
const ipAllowed = (key: string | null, max: number, windowMs: number): boolean =>
  key === null || rateLimit(key, max, windowMs).allowed;

/** 用归一化键（username_key / email_key）查找；已注销账号不可登录 */
async function findUserByIdentifier(identifier: string) {
  const key = normalizeKey(identifier);
  const rows = await getWebDb()
    .select()
    .from(users)
    .where(and(eq(users.state, "active"), or(eq(users.usernameKey, key), eq(users.emailKey, key))))
    .limit(1);
  return rows[0] ?? null;
}

export async function loginAction(formData: FormData): Promise<void> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  // 双层频控：IP 级（防撞库）+ 账号级（防定向爆破）
  const accountKey = `login-account:${normalizeKey(identifier)}`;
  if (
    !ipAllowed(await ipRateKey("login-ip"), 20, 10 * 60_000) ||
    !rateLimit(accountKey, 5, 10 * 60_000).allowed
  ) {
    redirect("/login?error=" + encodeURIComponent("尝试过于频繁，请 10 分钟后再试"));
  }

  const user = await findUserByIdentifier(identifier);
  if (!user || !user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
    redirect("/login?error=" + encodeURIComponent("用户名或密码错误"));
  }

  // 全站封禁拦截（含理由与期限）
  const ban = await findActiveGlobalBan(user.id);
  if (ban) {
    const until = ban.endsAt ? `，至 ${ban.endsAt}` : "（永久）";
    redirect("/login?error=" + encodeURIComponent(`账号已被封禁${until}：${ban.reason || "违规"}`));
  }

  await getWebDb()
    .update(users)
    .set({ lastLoginAt: sql`NOW()` })
    .where(eq(users.id, user.id));
  await createSession(user.id, {
    ip: clientIpFrom(await headers()),
    userAgent: (await headers()).get("user-agent") ?? "",
  });
  redirect("/");
}

export async function registerAction(formData: FormData): Promise<void> {
  const mode = await getRegisterMode();
  const username = String(formData.get("username") ?? "").trim();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const invite = String(formData.get("invite") ?? "").trim();

  const fail = (msg: string): never => redirect(`/register?error=${encodeURIComponent(msg)}`);

  if (!ipAllowed(await ipRateKey("register"), 5, 60 * 60_000)) {
    fail("注册过于频繁，请稍后再试");
  }
  if (!USERNAME_RE.test(username)) fail("用户名需 2-20 位（中文/字母/数字/下划线）");
  if (!EMAIL_RE.test(email)) fail("邮箱格式不正确");
  if (password.length < 8) fail("密码至少 8 位");

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
    if (e instanceof RegisterError) return fail(e.message);
    throw e;
  }

  if (mode === "open") {
    // 开放注册：邮箱验证令牌（验证前可登录、可浏览，写类权限由评估器拦截）
    const token = await issueEmailToken(newId, "verify");
    const { APP_URL: appUrl } = await import("@/lib/site");
    await sendMail(email, verifyEmailMail(`${appUrl}/verify/${token}`));
  }

  await createSession(newId, {
    ip: clientIpFrom(await headers()),
    userAgent: (await headers()).get("user-agent") ?? "",
  });
  redirect(mode === "invite" ? "/" : "/?notice=verify-email-sent");
}

export async function forgotAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  // 同时按邮箱限额：既防对同一受害邮箱的邮件轰炸，也在无可信 IP 时兜底
  if (
    !ipAllowed(await ipRateKey("forgot"), 5, 15 * 60_000) ||
    !rateLimit(`forgot-email:${normalizeKey(email)}`, 3, 60 * 60_000).allowed
  ) {
    redirect("/forgot?sent=1"); // 频控也返回中性视图
  }

  const db = getWebDb();
  const rows = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.emailKey, normalizeKey(email)), eq(users.state, "active")))
    .limit(1);
  const user = rows[0];
  if (user) {
    const purpose = user.passwordHash ? "reset" : "claim";
    const token = await issueEmailToken(user.id, purpose);
    const { APP_URL } = await import("@/lib/site");
    const link = `${APP_URL}/${purpose === "claim" ? "claim" : "reset"}/${token}`;
    await sendMail(email, purpose === "claim" ? claimMail(link) : resetPasswordMail(link));
  }
  redirect("/forgot?sent=1");
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
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
}

export async function claimAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

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
}

export async function logoutAction(): Promise<void> {
  await destroyCurrentSession();
  redirect("/");
}
