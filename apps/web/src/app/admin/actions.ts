"use server";

// 授权管理会派发 role.changed：使用内核的 Server Action 须自行求值模块注册表（硬约定 9），
// 否则事件只落 event_log、消费者不会被调用（modules-import-guard.test.ts 守护）
import "@/modules";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  AdminError,
  createCustomRole,
  deleteCustomRole,
  grantRolePermission,
  revokeRolePermission,
} from "@/lib/authz/admin";
import { requireAdmin } from "@/lib/authz/require-admin";

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
  const actor = await requireAdmin("admin.roles");
  const key = String(formData.get("key") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  await run("/admin/authz", () => createCustomRole(actor, key, name, description));
  revalidatePath("/admin/authz");
  redirect(`/admin/authz/${key}`);
}

export async function deleteRoleAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin("admin.roles");
  const key = String(formData.get("key") ?? "");
  await run("/admin/authz", () => deleteCustomRole(actor, key));
  revalidatePath("/admin/authz");
  redirect("/admin/authz");
}

export async function grantAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin("admin.roles");
  const roleKey = String(formData.get("roleKey") ?? "");
  const permissionKey = String(formData.get("permissionKey") ?? "");
  await run(`/admin/authz/${roleKey}`, () =>
    grantRolePermission(actor, roleKey, permissionKey, scopeOf(formData)),
  );
  revalidatePath(`/admin/authz/${roleKey}`);
}

export async function revokeAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin("admin.roles");
  const roleKey = String(formData.get("roleKey") ?? "");
  const permissionKey = String(formData.get("permissionKey") ?? "");
  await run(`/admin/authz/${roleKey}`, () =>
    revokeRolePermission(actor, roleKey, permissionKey, scopeOf(formData)),
  );
  revalidatePath(`/admin/authz/${roleKey}`);
}
