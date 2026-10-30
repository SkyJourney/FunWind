import { and, asc, eq, isNull, notExists, or, sql, type AnyColumn } from "drizzle-orm";
import { cache } from "react";
import { accountDeletionRequests, getWebDb, roles, userRoles, users } from "@funwind/db";

export interface PublicRoleIdentity {
  key: string;
  name: string;
  scopeId: number;
  scopeLabel: string;
}

/** 状态列或已完成注销 tombstone 任一成立时，统一视为公开匿名身份。 */
export const publicUserDeleted = (userId: AnyColumn, state: AnyColumn) =>
  sql<boolean>`(${userId} IS NOT NULL AND (
    ${state} IS NULL OR ${state} = 'deleted' OR EXISTS (
      SELECT 1 FROM account_deletion_requests adr
      WHERE adr.user_id = ${userId} AND adr.status = 'completed'
    )
  ))`;

/** 公共身份名：注销身份永远只呈现统一匿名名称。 */
export const publicUsername = (username: AnyColumn, state: AnyColumn, userId: AnyColumn) =>
  sql<
    string | null
  >`CASE WHEN ${publicUserDeleted(userId, state)} THEN '已注销用户' ELSE ${username} END`;

/** 公共身份不暴露已注销用户的 UID。 */
export const publicUserId = (userId: AnyColumn, state: AnyColumn) =>
  sql<number | null>`CASE WHEN ${publicUserDeleted(userId, state)} THEN NULL ELSE ${userId} END`;

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
        eq(users.state, "active"),
        eq(roles.kind, "custom"),
        eq(roles.isPublic, true),
        or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > NOW()`),
        notExists(
          getWebDb()
            .select({ id: accountDeletionRequests.id })
            .from(accountDeletionRequests)
            .where(
              and(
                eq(accountDeletionRequests.userId, users.id),
                eq(accountDeletionRequests.status, "completed"),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(userRoles.scopeId), asc(roles.name))
    .limit(5);
  return rows.map((role) => ({
    ...role,
    scopeLabel: role.scopeId === 0 ? "全站" : "板块范围",
  }));
});
