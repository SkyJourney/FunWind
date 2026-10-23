"use server";

import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import {
  checkPermission,
  createCustomRole,
  deleteCustomRole,
  grantRolePermission,
  revokeRolePermission,
} from "@/lib/authz/service";

async function requireAdmin(): Promise<number> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const r = await checkPermission(user.id, "admin.roles");
  if (!r.allowed) notFound();
  return user.id;
}

const ROLE_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function createRoleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const key = String(formData.get("key") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!ROLE_KEY_RE.test(key)) {
    redirect("/admin/authz?error=" + encodeURIComponent("角色键需为 kebab-case"));
  }
  await createCustomRole(key, name || key, description);
  revalidatePath("/admin/authz");
  redirect(`/admin/authz/${key}`);
}

export async function deleteRoleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const key = String(formData.get("key") ?? "");
  try {
    await deleteCustomRole(key);
  } catch (e) {
    redirect(
      "/admin/authz?error=" + encodeURIComponent(e instanceof Error ? e.message : String(e)),
    );
  }
  revalidatePath("/admin/authz");
  redirect("/admin/authz");
}

export async function grantAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const roleKey = String(formData.get("roleKey") ?? "");
  const permissionKey = String(formData.get("permissionKey") ?? "");
  const scopeType = String(formData.get("scopeType") ?? "global");
  const forumIdRaw = String(formData.get("forumId") ?? "");
  const forumId = scopeType === "forum" && forumIdRaw !== "" ? Number(forumIdRaw) : null;
  if (scopeType === "forum" && (forumId === null || !Number.isInteger(forumId))) {
    redirect(`/admin/authz/${roleKey}?error=` + encodeURIComponent("版块作用域需选择版块"));
  }
  await grantRolePermission(roleKey, permissionKey, forumId);
  revalidatePath(`/admin/authz/${roleKey}`);
}

export async function revokeAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const roleKey = String(formData.get("roleKey") ?? "");
  const permissionKey = String(formData.get("permissionKey") ?? "");
  const scopeType = String(formData.get("scopeType") ?? "global");
  const forumIdRaw = String(formData.get("forumId") ?? "");
  const forumId = scopeType === "forum" && forumIdRaw !== "" ? Number(forumIdRaw) : null;
  await revokeRolePermission(roleKey, permissionKey, forumId);
  revalidatePath(`/admin/authz/${roleKey}`);
}
