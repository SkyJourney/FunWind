import "server-only";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { cache } from "react";
import { getWebDb, roles, userRoles, users } from "@funwind/db";
import { userNotDeleted } from "@/lib/identity-expr";

export interface PublicRoleIdentity {
  key: string;
  name: string;
  scopeId: number;
  scopeLabel: string;
}

/** 仅返回显式公开、仍有效的自定义角色；板块作用域不公开具体受限版块名。 */
export const publicRolesOf = cache(async (userId: number): Promise<PublicRoleIdentity[]> => {
  const rows = await getWebDb()
    .select({ key: roles.key, name: roles.name, scopeId: userRoles.scopeId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.key, userRoles.roleKey))
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(
        eq(userRoles.userId, userId),
        userNotDeleted(users.id, users.state),
        eq(roles.kind, "custom"),
        eq(roles.isPublic, true),
        or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > NOW()`),
      ),
    )
    .orderBy(asc(userRoles.scopeId), asc(roles.name))
    .limit(5);
  return rows.map((role) => ({
    ...role,
    scopeLabel: role.scopeId === 0 ? "全站" : "板块范围",
  }));
});
