"use server";

import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getWebDb, notificationPreferences, userProfiles, users } from "@funwind/db";
import { defineAction } from "@/lib/actions/define-action";
import { getCurrentUser } from "@/lib/auth/session";
import { hashPassword, verifyLegacyPassword, verifyPassword } from "@/lib/auth/password";
import { isValidEmail } from "@/lib/auth/email";
import { MUST_CHANGE_COOKIE, revokeOtherSessions } from "@/lib/auth/session";

/**
 * 账号设置动作（M10.6c）：改密码（双轨强制换密同一入口）/ 改邮箱 / 资料。
 * 改密销毁旧哈希凭据（legacy 两列清场）并吊销其他会话；强制态免验当前密码（服务端复核 pending）。
 */

const PASSWORD_MAX = 1024;
const text = (max: number) => z.string().max(max).default("");

const errHop = (page: string, code: string) =>
  `/settings/${page}?error=${encodeURIComponent(code)}`;

/** 当前密码校验规则：有 argon2 哈希 → 必验；双轨待换密 → 免验（旧哈希即钥匙，已验过） */
async function requireCurrentOk(
  userId: number,
  current: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const [row] = await getWebDb()
    .select({
      passwordHash: users.passwordHash,
      legacyPasswordHash: users.legacyPasswordHash,
      legacyPending: users.legacyPasswordPending,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return { ok: false, code: "账号不存在" };
  if (row.legacyPending) {
    if (row.legacyPasswordHash !== null && !verifyLegacyPassword(row.legacyPasswordHash, current)) {
      // 强制态不强制重输旧密，但若填了必须对——防离开键盘被改
      if (current !== "") return { ok: false, code: "当前密码不正确" };
    }
    return { ok: true };
  }
  if (row.passwordHash === null) return { ok: false, code: "请先通过邮件认领设置密码" };
  if (current === "") return { ok: false, code: "请输入当前密码" };
  if (!(await verifyPassword(row.passwordHash, current))) {
    return { ok: false, code: "当前密码不正确" };
  }
  return { ok: true };
}

export const updatePasswordAction = defineAction({
  name: "settings.password",
  auth: "user",
  input: z.object({
    current: text(PASSWORD_MAX),
    password: z.string().min(1).max(PASSWORD_MAX),
    confirm: z.string().min(1).max(PASSWORD_MAX),
  }),
  async run(ctx, input) {
    const user = await getCurrentUser();
    if (!user) redirect("/login");
    if (input.password.length < 8) {
      redirect(errHop("password", "新密码至少 8 位"));
    }
    if (input.password !== input.confirm) {
      redirect(errHop("password", "两次输入的新密码不一致"));
    }
    const cur = await requireCurrentOk(ctx.userId!, input.current);
    if (!cur.ok) redirect(errHop("password", cur.code));

    await getWebDb()
      .update(users)
      .set({
        passwordHash: await hashPassword(input.password),
        legacyPasswordHash: null, // 设密即销毁旧哈希凭据（双轨闭环）
        legacyPasswordPending: false,
      })
      .where(eq(users.id, ctx.userId!));
    await revokeOtherSessions(ctx.userId!);
    (await cookies()).delete(MUST_CHANGE_COOKIE);
    revalidatePath("/", "layout");
    redirect("/settings/password?saved=1");
  },
});

export const updateEmailAction = defineAction({
  name: "settings.email",
  auth: "user",
  input: z.object({
    email: text(254),
    current: text(PASSWORD_MAX),
  }),
  async run(ctx, input) {
    const user = await getCurrentUser();
    if (!user) redirect("/login");
    const email = input.email.trim();
    if (email === "" || !isValidEmail(email)) {
      redirect(errHop("email", "邮箱格式不正确"));
    }
    const cur = await requireCurrentOk(ctx.userId!, input.current);
    if (!cur.ok) redirect(errHop("email", cur.code));

    const key = email.toLowerCase();
    const [taken] = await getWebDb()
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.emailKey, key), ne(users.id, ctx.userId!)))
      .limit(1);
    if (taken) redirect(errHop("email", "该邮箱已被其他账号使用"));

    await getWebDb()
      .update(users)
      .set({ email, emailKey: key, emailVerifiedAt: null })
      .where(eq(users.id, ctx.userId!));
    redirect("/settings/email?saved=1");
  },
});

export const updateProfileAction = defineAction({
  name: "settings.profile",
  auth: "user",
  input: z.object({
    bio: text(500),
    location: text(100),
    website: text(200),
    gender: z.coerce.number().int().min(0).max(2).default(0),
    birthday: text(10), // YYYY-MM-DD 或空
    signature: text(200),
  }),
  async run(ctx, input) {
    const user = await getCurrentUser();
    if (!user) redirect("/login");
    const website = input.website.trim();
    if (website !== "" && !/^https?:\/\//.test(website)) {
      redirect(errHop("profile", "主页地址需以 http(s):// 开头"));
    }
    const birthday = input.birthday.trim();
    if (birthday !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
      redirect(errHop("profile", "生日格式应为 YYYY-MM-DD"));
    }
    const values = {
      bio: input.bio.trim() === "" ? null : input.bio.trim(),
      location: input.location.trim(),
      website,
      gender: input.gender,
      birthday: birthday === "" ? null : birthday,
      signatureMd: input.signature.trim() === "" ? null : input.signature.trim(),
    };
    await getWebDb()
      .insert(userProfiles)
      .values({ userId: ctx.userId!, ...values })
      .onDuplicateKeyUpdate({ set: values });
    revalidatePath("/settings/profile");
    revalidatePath(`/u/${ctx.userId!}`);
    redirect("/settings/profile?saved=1");
  },
});

export const toggleNotifPrefAction = defineAction({
  name: "settings.notif_pref",
  auth: "user",
  input: z.object({
    type: z.string().min(1).max(48),
    enabled: z.enum(["on", "off"]),
  }),
  async run(ctx, input) {
    const user = await getCurrentUser();
    if (!user) redirect("/login");
    const enabled = input.enabled === "on";
    await getWebDb()
      .insert(notificationPreferences)
      .values({ userId: ctx.userId!, type: input.type, channel: "in_app", enabled })
      .onDuplicateKeyUpdate({ set: { enabled } });
    revalidatePath("/settings/notifications");
    redirect("/settings/notifications");
  },
});
