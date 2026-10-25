"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AdminError } from "@/lib/authz/admin";
import { defineAction } from "@/lib/actions/define-action";
import { createRestriction, liftRestriction } from "@/lib/authz/restrictions-admin";
import { assignUserRole, revokeUserRole } from "@/lib/authz/admin";

/** 用户管理 Server Actions（M9，admin.users）：限制创建/解除、角色授予/撤销（复用 M5 服务）。 */

function actor(userId: number | null, ip: string | null) {
  return { userId: userId ?? 0, via: "admin" as const, ip };
}

const createInput = z.object({
  userId: z.coerce.number().int().positive(),
  kind: z.enum(["ban", "mute", "no_avatar", "no_signature"]),
  reason: z.string().max(500).default(""),
  /** 空 = 永久；格式 YYYY-MM-DD HH:MM（datetime-local） */
  endsAt: z.string().max(32).default(""),
});
export const createRestrictionAction = defineAction({
  name: "admin.restriction.create",
  auth: { admin: "admin.users" },
  input: createInput,
  async run(ctx, input) {
    const endsAt = input.endsAt === "" ? null : `${input.endsAt.replace("T", " ")}:00`.slice(0, 19);
    const r = await createRestriction(actor(ctx.userId, ctx.ip), {
      userId: input.userId,
      kind: input.kind,
      reason: input.reason,
      endsAt,
    });
    const back = `/admin/users/${input.userId}`;
    if (!r.ok) {
      const msg =
        r.code === "already"
          ? "该类型的限制已在生效中（先解除再新建）"
          : r.code === "reason_required"
            ? "必须填写理由"
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
    const r = await liftRestriction(actor(ctx.userId, ctx.ip), input.restrictionId, input.note);
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
});
export const assignRoleAction = defineAction({
  name: "admin.user_role.assign",
  auth: { admin: "admin.users" },
  input: assignRoleInput,
  async run(ctx, input) {
    const back = `/admin/users/${input.userId}`;
    try {
      await assignUserRole(actor(ctx.userId, ctx.ip), input.userId, input.roleKey, input.scopeId);
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
});
export const revokeRoleAction = defineAction({
  name: "admin.user_role.revoke",
  auth: { admin: "admin.users" },
  input: revokeRoleInput,
  async run(ctx, input) {
    const back = `/admin/users/${input.userId}`;
    await revokeUserRole(actor(ctx.userId, ctx.ip), input.userId, input.roleKey, input.scopeId);
    revalidatePath(back);
    redirect(`${back}?role=1`);
  },
});
