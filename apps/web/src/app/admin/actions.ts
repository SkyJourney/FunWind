"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import {
  AdminError,
  createCustomRole,
  deleteCustomRole,
  grantRolePermission,
  revokeRolePermission,
  setRolePublic,
} from "@/lib/authz/admin";

/**
 * 授权管理 Server Actions。统一经 defineAction：`auth: { admin: "admin.roles" }` 保证**第一个 await 就是 requireAdmin**
 * （先鉴权、后读表单与取数，admin-entry-guard 静态守护），并求值模块注册表（授权管理会派发 role.changed，硬约定 9）。
 */

/** 表单里的短文本字段：缺失按空串，设上限防巨型输入（业务合法性由 lib/authz/admin 的校验给出可读消息） */
const text = (max: number) => z.string().max(max).default("");

/** 执行管理写操作；校验类错误（AdminError）带着消息跳回，其余异常照常抛出 */
async function guarded(back: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AdminError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
}

/** 作用域：缺失按全局（0）；非法值返回 -1，由 requireScope 拒绝 */
const scopeOf = (rawInput: string): number => {
  const raw = (rawInput === "" ? "0" : rawInput).trim();
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : -1; // -1 会被 requireScope 拒绝
};

const createRoleInput = z.object({ key: text(200), name: text(200), description: text(1000) });
export const createRoleAction = defineAction({
  name: "admin.role.create",
  auth: { admin: "admin.roles" },
  input: createRoleInput,
  async run(ctx, input) {
    const key = input.key.trim();
    const name = input.name.trim();
    const description = input.description.trim();
    await guarded("/admin/authz", () => createCustomRole(ctx.admin!, key, name, description));
    revalidatePath("/admin/authz");
    redirect(`/admin/authz/${key}`);
  },
});

export const deleteRoleAction = defineAction({
  name: "admin.role.delete",
  auth: { admin: "admin.roles" },
  input: z.object({ key: text(200) }),
  async run(ctx, input) {
    await guarded("/admin/authz", () => deleteCustomRole(ctx.admin!, input.key));
    revalidatePath("/admin/authz");
    redirect("/admin/authz");
  },
});

export const setRolePublicAction = defineAction({
  name: "admin.role.visibility",
  auth: { admin: "admin.roles" },
  input: z.object({ roleKey: text(200), isPublic: z.enum(["on", "off"]) }),
  async run(ctx, input) {
    const back = `/admin/authz/${input.roleKey}`;
    await guarded(back, () => setRolePublic(ctx.admin!, input.roleKey, input.isPublic === "on"));
    revalidatePath(back);
    redirect(`${back}?public=1`);
  },
});

const grantInput = z.object({ roleKey: text(200), permissionKey: text(200), scopeId: text(20) });

export const grantAction = defineAction({
  name: "admin.grant.add",
  auth: { admin: "admin.roles" },
  input: grantInput,
  async run(ctx, input) {
    await guarded(`/admin/authz/${input.roleKey}`, () =>
      grantRolePermission(ctx.admin!, input.roleKey, input.permissionKey, scopeOf(input.scopeId)),
    );
    revalidatePath(`/admin/authz/${input.roleKey}`);
  },
});

export const revokeAction = defineAction({
  name: "admin.grant.revoke",
  auth: { admin: "admin.roles" },
  input: grantInput,
  async run(ctx, input) {
    await guarded(`/admin/authz/${input.roleKey}`, () =>
      revokeRolePermission(ctx.admin!, input.roleKey, input.permissionKey, scopeOf(input.scopeId)),
    );
    revalidatePath(`/admin/authz/${input.roleKey}`);
  },
});
