"use server";

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getWebDb, users, inviteCodes, userBans } from "@funwind/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
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

async function clientKey(prefix: string): Promise<string> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  return `${prefix}:${ip}`;
}

async function findUserByIdentifier(identifier: string) {
  const db = getWebDb();
  const rows = await db
    .select()
    .from(users)
    .where(or(eq(users.username, identifier), eq(users.email, identifier)))
    .limit(1);
  return rows[0] ?? null;
}

export async function loginAction(formData: FormData): Promise<void> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const limiter = await clientKey("login");
  if (!rateLimit(limiter, 10, 10 * 60_000).allowed) {
    redirect("/login?error=" + encodeURIComponent("尝试过于频繁，请 10 分钟后再试"));
  }

  const user = await findUserByIdentifier(identifier);
  if (!user || !user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
    redirect("/login?error=" + encodeURIComponent("用户名或密码错误"));
  }

  // 全局封禁拦截（含理由与期限）
  const db = getWebDb();
  const bans = await db
    .select({ reason: userBans.reason, endTime: userBans.endTime })
    .from(userBans)
    .where(
      and(
        eq(userBans.userId, user.id),
        eq(userBans.fid, 0),
        sql`(${userBans.endTime} IS NULL OR ${userBans.endTime} > NOW())`,
      ),
    )
    .limit(1);
  if (bans[0]) {
    const until = bans[0].endTime ? `，至 ${bans[0].endTime}` : "（永久）";
    redirect(
      "/login?error=" + encodeURIComponent(`账号已被封禁${until}：${bans[0].reason || "违规"}`),
    );
  }

  await createSession(user.id, {
    ip: limiter.replace("login:", ""),
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

  if (!rateLimit(await clientKey("register"), 5, 60 * 60_000).allowed) {
    fail("注册过于频繁，请稍后再试");
  }
  if (!USERNAME_RE.test(username)) fail("用户名需 2-20 位（中文/字母/数字/下划线）");
  if (!EMAIL_RE.test(email)) fail("邮箱格式不正确");
  if (password.length < 8) fail("密码至少 8 位");

  const db = getWebDb();
  const taken = await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.username, username), eq(users.email, email)))
    .limit(1);
  if (taken[0]) fail("用户名或邮箱已被使用");

  let verifiedAt: string | null = null;
  if (mode === "invite") {
    const rows = await db
      .select()
      .from(inviteCodes)
      .where(and(eq(inviteCodes.code, invite), isNull(inviteCodes.usedBy)))
      .limit(1);
    const code = rows[0];
    if (
      !code ||
      (code.expiresAt && code.expiresAt < new Date().toISOString().slice(0, 19).replace("T", " "))
    ) {
      fail("邀请码无效或已被使用");
    }
    // 原子核销（防并发复用）
    const result = await db
      .update(inviteCodes)
      .set({ usedBy: 0, usedAt: sql`NOW()` })
      .where(and(eq(inviteCodes.code, invite), isNull(inviteCodes.usedBy)));
    if ((result as unknown as [{ affectedRows: number }])[0]?.affectedRows === 0) {
      fail("邀请码无效或已被使用");
    }
  } else {
    verifiedAt = null; // 待邮箱验证
  }

  // 新 uid = max+1（users.id 保留旧主键无自增；单实例注册无并发竞争，加锁防撞）
  const [maxRow] = await db.select({ m: sql<number>`COALESCE(MAX(id), 0)` }).from(users);
  const newId = Number(maxRow?.m ?? 0) + 1;
  await db.insert(users).values({
    id: newId,
    username,
    email,
    passwordHash: await hashPassword(password),
    groupId: 1,
    emailVerifiedAt: verifiedAt,
    createdAt: sql`NOW()`,
    credits: { "1": 0 },
  });
  if (mode === "invite") {
    await db.update(inviteCodes).set({ usedBy: newId }).where(eq(inviteCodes.code, invite));
  } else {
    // 开放注册：邮箱验证令牌（验证前可登录但站点功能在 M5 权限处收敛）
    const token = await issueEmailToken(newId, "verify");
    const { APP_URL: appUrl } = await import("@/lib/site");
    await sendMail(email, verifyEmailMail(`${appUrl}/verify/${token}`));
  }

  await createSession(newId, {
    ip: await clientKey("ip"),
    userAgent: (await headers()).get("user-agent") ?? "",
  });
  redirect(mode === "invite" ? "/" : "/?notice=verify-email-sent");
}

export async function forgotAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!rateLimit(await clientKey("forgot"), 5, 15 * 60_000).allowed) {
    redirect("/forgot?sent=1"); // 频控也返回中性视图
  }

  const db = getWebDb();
  const rows = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
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
