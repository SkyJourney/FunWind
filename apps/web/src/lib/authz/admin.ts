import "server-only";

import { eq, sql } from "drizzle-orm";
import {
  getWebDb,
  PERMISSION_DEFINITIONS,
  roleGrants,
  roles,
  type PermissionDef,
} from "@funwind/db";
import { writeAudit } from "@/lib/audit";
import { AdminError } from "./admin-error";
import {
  BUILTIN_ROLES,
  findRole,
  isBackstagePermission,
  lockExistingRole,
  type AdminActor,
} from "./admin-shared";

/** 授权管理的兼容入口。角色、授权与用户绑定的写内核同时供后台和 REST 使用。 */
export { AdminError };
export type { AdminActor } from "./admin-shared";
export {
  applyRoleCreate,
  applyRoleDelete,
  applyRoleGrant,
  applyRoleRevoke,
  createCustomRole,
  deleteCustomRole,
  grantRolePermission,
  lockRoleGrant,
  planRoleCreate,
  planRoleDelete,
  planRoleGrant,
  planRoleRevoke,
  revokeRolePermission,
  type RoleCreateCode,
  type RoleCreateDenial,
  type RoleDeleteCode,
  type RoleDeleteDenial,
  type RoleGrantCode,
  type RoleGrantDenial,
  type RoleRevokeCode,
  type RoleRevokeDenial,
} from "./admin-role-writes";
export {
  applyUserAssign,
  applyUserRevoke,
  assignUserRole,
  dispatchRoleChanges,
  lockUserAssign,
  planUserRoleAssign,
  planUserRoleRevoke,
  revokeUserRole,
  type AdminDeps,
  type UserRoleAssignCode,
  type UserRoleAssignDenial,
  type UserRoleRevokeCode,
  type UserRoleRevokeDenial,
} from "./admin-user-role-writes";

export {
  ROLES_DENIAL_HTTP,
  prepareApiRoleCreate,
  prepareApiRoleDelete,
  prepareApiRoleGrant,
  prepareApiRoleRevoke,
  prepareApiUserRoleAssign,
  prepareApiUserRoleRevoke,
  type PreparedApiRoleCreate,
  type PreparedApiRoleDelete,
  type PreparedApiRoleGrant,
  type PreparedApiRoleRevoke,
  type PreparedApiUserRoleAssign,
  type PreparedApiUserRoleRevoke,
} from "./api-writes";

export async function listRoles(): Promise<
  {
    key: string;
    name: string;
    kind: string;
    description: string;
    isPublic: boolean;
    /** 授权点数与持有人数（列表页影响面展示，M9.5）；字面量限定名理由同 restrictions-admin */
    grantCount: number;
    holderCount: number;
  }[]
> {
  return getWebDb()
    .select({
      key: roles.key,
      name: roles.name,
      kind: roles.kind,
      description: roles.description,
      isPublic: roles.isPublic,
      grantCount:
        sql<number>`(SELECT COUNT(*) FROM role_grants WHERE role_grants.role_key = roles.key)`.mapWith(
          Number,
        ),
      holderCount:
        sql<number>`(SELECT COUNT(*) FROM user_roles WHERE user_roles.role_key = roles.key)`.mapWith(
          Number,
        ),
    })
    .from(roles)
    .orderBy(roles.kind, roles.key);
}

/** 词汇表是单一事实源（迁移、评估器、后台矩阵同源） */
export function listPermissions(): PermissionDef[] {
  return PERMISSION_DEFINITIONS;
}

export async function getRoleGrants(
  roleKey: string,
): Promise<{ permissionKey: string; scopeId: number }[]> {
  return getWebDb()
    .select({ permissionKey: roleGrants.permissionKey, scopeId: roleGrants.scopeId })
    .from(roleGrants)
    .where(eq(roleGrants.roleKey, roleKey))
    .orderBy(roleGrants.scopeId, roleGrants.permissionKey);
}

/** 显式设置自定义角色是否可作为公开身份展示；敏感管理角色不可公开。 */
export async function setRolePublic(
  actor: AdminActor,
  roleKey: string,
  isPublic: boolean,
): Promise<void> {
  if (!(await findRole(roleKey))) throw new AdminError(`角色不存在: ${roleKey}`);
  if (BUILTIN_ROLES.has(roleKey) && isPublic) throw new AdminError("内置角色不可公开展示");

  await getWebDb().transaction(async (tx) => {
    const role = await lockExistingRole(tx, roleKey);
    if (!role) throw new AdminError(`角色不存在: ${roleKey}`);
    if (role.kind === "builtin" && isPublic) throw new AdminError("内置角色不可公开展示");
    if (role.isPublic === isPublic) return;

    if (isPublic) {
      const grants = await tx
        .select({ permissionKey: roleGrants.permissionKey })
        .from(roleGrants)
        .where(eq(roleGrants.roleKey, roleKey));
      if (grants.some(({ permissionKey }) => isBackstagePermission(permissionKey))) {
        throw new AdminError("持有后台管理权限的角色不能公开展示");
      }
    }

    await tx.update(roles).set({ isPublic }).where(eq(roles.key, roleKey));
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "role.visibility.update",
      targetType: "role",
      targetId: roleKey,
      before: { isPublic: role.isPublic },
      after: { isPublic },
      ip: actor.ip,
    });
  });
}
