"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AdminError } from "@/lib/authz/admin";
import { defineAction } from "@/lib/actions/define-action";
import {
  createRestriction,
  liftRestriction,
  revokeUserSessionByAdmin,
} from "@/lib/authz/restrictions-admin";
import { assignUserRole, revokeUserRole } from "@/lib/authz/admin";
import { AppealError, resolveUserAppeal } from "@/lib/authz/appeals";
import { isTeamMembershipRole } from "@/lib/authz/team-role-mapping";
import { assignTeamMembership, revokeTeamMembership } from "@/lib/authz/team-membership";
import { isValidEmail } from "@/lib/auth/email";
import { changeEmailAddress } from "@/lib/auth/email-change";
import { rateLimit } from "@/lib/auth/ratelimit";
import { hashEmailKey } from "@/lib/auth/tokens";
import {
  emailChangedAlertMail,
  emailChangedConfirmMail,
  getMailBrand,
  trySendMail,
  verifyEmailMail,
} from "@/lib/mail";
import { securityEmailEnabled } from "@/lib/notifications/email";

/** 用户管理 Server Actions（M9，admin.users）：限制创建/解除、角色授予/撤销（复用 M5 服务）。 */

const createInput = z.object({
  userId: z.coerce.number().int().positive(),
  kind: z.enum(["ban", "forum_ban", "mute", "no_avatar", "no_signature"]),
  scopeId: z.coerce.number().int().min(0).default(0),
  reason: z.string().max(255).default(""),
  /** 空 = 永久；格式 YYYY-MM-DD HH:MM（datetime-local） */
  endsAt: z.string().max(32).default(""),
});
export const createRestrictionAction = defineAction({
  name: "admin.restriction.create",
  auth: { admin: "admin.users" },
  input: createInput,
  async run(ctx, input) {
    const endsAt = input.endsAt === "" ? null : `${input.endsAt.replace("T", " ")}:00`.slice(0, 19);
    const r = await createRestriction(ctx.actor, {
      userId: input.userId,
      kind: input.kind,
      scopeId: input.scopeId,
      reason: input.reason,
      endsAt,
    });
    const back = `/admin/users/${input.userId}`;
    if (!r.ok) {
      const msg =
        r.code === "already"
          ? "该类型和作用域的限制已在生效中（先解除再新建）"
          : r.code === "reason_required"
            ? "必须填写理由"
            : r.code === "reason_too_long"
              ? "理由不能超过 255 个字符"
              : r.code === "bad_ends_at"
                ? "结束时间必须是有效的未来时间"
                : r.code === "bad_scope"
                  ? "限制类型与作用域不匹配，或版块不存在"
                  : r.code === "bad_state"
                    ? "不能对注销中或已注销账号施加限制"
                    : r.code === "last_admin"
                      ? "不能封禁最后一位有效站点管理员"
                      : "用户不存在";
      redirect(`${back}?error=${encodeURIComponent(msg)}`);
    }
    revalidatePath(back);
    redirect(`${back}?restricted=1`);
  },
});

const liftInput = z.object({
  restrictionId: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
  note: z.string().max(500).default(""),
});
export const liftRestrictionAction = defineAction({
  name: "admin.restriction.lift",
  auth: { admin: "admin.users" },
  input: liftInput,
  async run(ctx, input) {
    const r = await liftRestriction(ctx.actor, input.restrictionId, input.note);
    const back = `/admin/users/${input.userId}`;
    if (!r.ok) {
      const msg = r.code === "reason_required" ? "必须填写解除说明" : "限制不存在或已过期";
      redirect(`${back}?error=${encodeURIComponent(msg)}`);
    }
    revalidatePath(back);
    redirect(`${back}?lifted=1`);
  },
});

const assignRoleInput = z.object({
  userId: z.coerce.number().int().positive(),
  roleKey: z.string().max(64),
  scopeId: z.coerce.number().int().min(0).default(0),
  expiresAt: z.string().max(32).default(""),
  reason: z.string().trim().min(1, "必须填写授予理由").max(255, "授予理由不能超过 255 个字符"),
});
export const assignRoleAction = defineAction({
  name: "admin.user_role.assign",
  auth: { admin: "admin.users" },
  input: assignRoleInput,
  async run(ctx, input) {
    const back = `/admin/users/${input.userId}`;
    const expiresAt =
      input.expiresAt === "" ? null : `${input.expiresAt.replace("T", " ")}:00`.slice(0, 19);
    try {
      if (isTeamMembershipRole(input.roleKey)) {
        if (input.scopeId !== 0) throw new AdminError("固定团队角色只能绑定为全站身份");
        await assignTeamMembership(ctx.actor, {
          userId: input.userId,
          roleKey: input.roleKey,
          expiresAt,
          reason: input.reason,
        });
      } else {
        await assignUserRole(
          ctx.actor,
          input.userId,
          input.roleKey,
          input.scopeId,
          expiresAt,
          input.reason,
        );
      }
    } catch (e) {
      if (e instanceof AdminError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    revalidatePath(back);
    redirect(`${back}?role=1`);
  },
});

const revokeRoleInput = z.object({
  userId: z.coerce.number().int().positive(),
  roleKey: z.string().max(64),
  scopeId: z.coerce.number().int().min(0).default(0),
  reason: z.string().trim().min(1, "必须填写撤销理由").max(255, "撤销理由不能超过 255 个字符"),
});
export const revokeRoleAction = defineAction({
  name: "admin.user_role.revoke",
  auth: { admin: "admin.users" },
  input: revokeRoleInput,
  async run(ctx, input) {
    const back = `/admin/users/${input.userId}`;
    try {
      if (isTeamMembershipRole(input.roleKey)) {
        if (input.scopeId !== 0) throw new AdminError("固定团队角色只能绑定为全站身份");
        await revokeTeamMembership(ctx.actor, input.userId, input.roleKey, input.reason);
      } else {
        await revokeUserRole(ctx.actor, input.userId, input.roleKey, input.scopeId, input.reason);
      }
    } catch (e) {
      if (e instanceof AdminError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    revalidatePath(back);
    redirect(`${back}?role=1`);
  },
});

export const revokeUserSessionAction = defineAction({
  name: "admin.user_session.revoke",
  auth: { admin: "admin.users" },
  input: z.object({
    userId: z.coerce.number().int().positive(),
    sessionId: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  async run(ctx, input) {
    const back = `/admin/users/${input.userId}`;
    const result = await revokeUserSessionByAdmin(ctx.actor, input.userId, input.sessionId);
    if (!result.ok) redirect(`${back}?error=${encodeURIComponent("会话已不存在或已被吊销")}`);
    revalidatePath(back);
    redirect(`${back}?session=revoked`);
  },
});

export const resolveUserAppealAction = defineAction({
  name: "admin.user_appeal.resolve",
  auth: { admin: "admin.users" },
  input: z.object({
    userId: z.coerce.number().int().positive(),
    appealId: z.coerce.number().int().positive(),
    status: z.enum(["approved", "rejected"]),
    result: z.string().trim().min(1).max(1000),
  }),
  async run(ctx, input) {
    const back = `/admin/users/${input.userId}`;
    try {
      await resolveUserAppeal(ctx.actor, input.appealId, input.status, input.result);
    } catch (error) {
      if (error instanceof AppealError) {
        redirect(`${back}?error=${encodeURIComponent("申诉已处理或不存在，请刷新页面")}`);
      }
      throw error;
    }
    revalidatePath(back);
    redirect(`${back}?appeal=resolved`);
  },
});

/**
 * 管理员代改用户邮箱并重新发起验证（M11.3 清账）。
 * 站长拍板：留痕即可，不加理由字段与确认弹窗；不提供「手动标记已验证」，用户必须重走验证。
 * 登录门不在这里动：注册时填错邮箱的账号，门要等用户点新地址里的链接才解除。
 */
export const changeUserEmailAction = defineAction({
  name: "admin.user.email.change",
  auth: { admin: "admin.users" },
  input: z.object({
    userId: z.coerce.number().int().positive(),
    email: z.string().max(254),
  }),
  async run(ctx, input) {
    const back = `/admin/users/${input.userId}`;
    const fail = (message: string): never =>
      redirect(`${back}?error=${encodeURIComponent(message)}`);
    const email = input.email.trim();
    if (email === "" || !isValidEmail(email)) return fail("邮箱格式不正确");

    const key = email.toLowerCase();
    const securityOn = await securityEmailEnabled();
    const result = await changeEmailAddress(
      input.userId,
      email,
      key,
      ctx.ip,
      // 目标地址限流：防止借管理员入口给第三方邮箱刷验证邮件
      () => rateLimit(`email-change-to:${hashEmailKey(key)}`, 5, 60 * 60_000).allowed,
      { actorId: ctx.userId, action: "admin.user.email.change" },
    );
    if (result.kind === "rate_limited") return fail("该地址的验证邮件发送过于频繁，请稍后再试");
    if (result.kind === "taken") return fail("该邮箱已被其他账号使用");
    if (result.kind === "missing") return fail("账号不存在、已注销或正在注销，不能修改邮箱");
    if (result.kind === "unchanged") return fail("邮箱未变化：该账号邮箱已验证");

    const brand = await getMailBrand();
    // 安全告警只发给被用户验证过的旧地址：没验证过的地址从未被证明属于该用户（填错的邮箱可能是陌生人的），
    // 向它发「账号邮箱已更换」会让陌生人知道该地址在本站注册过
    if (securityOn && result.previouslyVerified) {
      if (result.emailChanged && result.beforeEmail) {
        await trySendMail(result.beforeEmail, emailChangedAlertMail(brand), {
          userId: input.userId,
        });
      }
      await trySendMail(email, emailChangedConfirmMail(brand), { userId: input.userId });
    }
    const sent = await trySendMail(
      email,
      verifyEmailMail(`${brand.siteUrl}/verify/${result.verifyToken}`, brand, { email }),
      { userId: input.userId },
    );
    revalidatePath(back);
    redirect(`${back}?emailChanged=${sent ? "sent" : "failed"}`);
  },
});
