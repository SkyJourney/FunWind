"use server";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/session";
import {
  AdminError,
  createCustomRole,
  deleteCustomRole,
  grantRolePermission,
  revokeRolePermission,
  type AdminActor,
} from "@/lib/authz/admin";
import { checkPermission } from "@/lib/authz/service";
import { loadSubject } from "@/lib/authz/subject";
import { clientIpFrom } from "@/lib/net/client-ip";

/** 后台动作门禁：须登录且持有 admin.roles；越权表现为 404（不暴露后台存在） */
async function requireAdmin(): Promise<AdminActor> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const subject = await loadSubject(user.id);
  const r = await checkPermission(subject, "admin.roles");
  if (!r.allowed) notFound();
  return { userId: user.id, ip: clientIpFrom(await headers()) };
}

/** 执行管理写操作；校验类错误（AdminError）带着消息跳回，其余异常照常抛出 */
async function run(back: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AdminError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
}

const scopeOf = (formData: FormData): number => {
  const raw = String(formData.get("scopeId") ?? "0").trim();
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : -1; // -1 会被 requireScope 拒绝
};

export async function createRoleAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const key = String(formData.get("key") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  await run("/admin/authz", () => createCustomRole(actor, key, name, description));
  revalidatePath("/admin/authz");
  redirect(`/admin/authz/${key}`);
}

export async function deleteRoleAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const key = String(formData.get("key") ?? "");
  await run("/admin/authz", () => deleteCustomRole(actor, key));
  revalidatePath("/admin/authz");
  redirect("/admin/authz");
}

export async function grantAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const roleKey = String(formData.get("roleKey") ?? "");
  const permissionKey = String(formData.get("permissionKey") ?? "");
  await run(`/admin/authz/${roleKey}`, () =>
    grantRolePermission(actor, roleKey, permissionKey, scopeOf(formData)),
  );
  revalidatePath(`/admin/authz/${roleKey}`);
}

export async function revokeAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const roleKey = String(formData.get("roleKey") ?? "");
  const permissionKey = String(formData.get("permissionKey") ?? "");
  await run(`/admin/authz/${roleKey}`, () =>
    revokeRolePermission(actor, roleKey, permissionKey, scopeOf(formData)),
  );
  revalidatePath(`/admin/authz/${roleKey}`);
}
