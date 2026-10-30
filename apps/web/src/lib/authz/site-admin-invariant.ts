import { and, eq, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  getWebDb,
  roleGrants,
  roles,
  userRestrictions,
  userRoles,
  users,
} from "@funwind/db";
import { restrictionActive } from "./restrictions";

export type AuthzTransaction = Parameters<
  Parameters<ReturnType<typeof getWebDb>["transaction"]>[0]
>[0];

export class SiteAdminInvariantError extends Error {
  constructor() {
    super("至少保留一位可以登录并管理角色的有效站点管理员");
    this.name = "SiteAdminInvariantError";
  }
}

/** 将可能撤销管理能力的事务串行化，避免并发操作同时移除最后一位管理员。 */
export async function lockSiteAdminInvariant(tx: AuthzTransaction): Promise<void> {
  const [row] = await tx
    .select({ key: roles.key })
    .from(roles)
    .where(eq(roles.key, "admin"))
    .limit(1)
    .for("update");
  if (!row) throw new SiteAdminInvariantError();
}

async function globalPermissionHolders(
  tx: AuthzTransaction,
  permissionKey: "site.admin" | "admin.roles",
  userId?: number,
): Promise<Set<number>> {
  const rows = await tx
    .selectDistinct({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .innerJoin(
      roleGrants,
      and(
        eq(roleGrants.roleKey, userRoles.roleKey),
        eq(roleGrants.permissionKey, permissionKey),
        eq(roleGrants.scopeId, 0),
      ),
    )
    .where(
      and(
        userId === undefined ? undefined : eq(userRoles.userId, userId),
        eq(userRoles.scopeId, 0),
        or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > NOW()`),
        eq(users.state, "active"),
        eq(users.legacyPasswordPending, false),
        isNotNull(users.passwordHash),
        notExists(
          tx
            .select({ id: accountDeletionRequests.id })
            .from(accountDeletionRequests)
            .where(
              and(
                eq(accountDeletionRequests.userId, users.id),
                inArray(accountDeletionRequests.status, ["pending", "completed"]),
              ),
            ),
        ),
        notExists(
          tx
            .select({ id: userRestrictions.id })
            .from(userRestrictions)
            .where(
              and(
                eq(userRestrictions.userId, users.id),
                eq(userRestrictions.kind, "ban"),
                eq(userRestrictions.scopeId, 0),
                restrictionActive,
              ),
            ),
        ),
      ),
    );
  return new Set(rows.map((row) => Number(row.userId)));
}

export async function isEffectiveSiteAdmin(tx: AuthzTransaction, userId: number): Promise<boolean> {
  const siteAdmins = await globalPermissionHolders(tx, "site.admin", userId);
  if (!siteAdmins.has(userId)) return false;
  const roleAdmins = await globalPermissionHolders(tx, "admin.roles", userId);
  return roleAdmins.has(userId);
}

export async function hasOtherEffectiveSiteAdmin(
  tx: AuthzTransaction,
  userId: number,
): Promise<boolean> {
  const siteAdmins = await globalPermissionHolders(tx, "site.admin");
  const roleAdmins = await globalPermissionHolders(tx, "admin.roles");
  return [...siteAdmins].some((candidate) => candidate !== userId && roleAdmins.has(candidate));
}

export async function hasEffectiveSiteAdmin(tx: AuthzTransaction): Promise<boolean> {
  const siteAdmins = await globalPermissionHolders(tx, "site.admin");
  if (siteAdmins.size === 0) return false;
  const roleAdmins = await globalPermissionHolders(tx, "admin.roles");
  return [...siteAdmins].some((userId) => roleAdmins.has(userId));
}

export async function assertEffectiveSiteAdminRemains(tx: AuthzTransaction): Promise<void> {
  if (!(await hasEffectiveSiteAdmin(tx))) throw new SiteAdminInvariantError();
}
