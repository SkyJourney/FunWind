import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { getWebDb, roleGrants, roles, userRestrictions, userRoles, users } from "@funwind/db";
import { userNotClosing } from "@/lib/identity-expr";
import { restrictionActive } from "./restrictions";

export type AuthzTransaction = Parameters<
  Parameters<ReturnType<typeof getWebDb>["transaction"]>[0]
>[0];

export const SITE_ADMIN_PERMISSIONS = ["site.admin", "admin.roles"] as const;

/** 与运行时字符串键一致，不折叠大小写、重音或尾空格。 */
export function exactAuthzKey(key: SQLWrapper | string) {
  return sql`CAST(${key} AS BINARY)`;
}

// 保留普通等值条件供索引定位；只有字节完全相同时才构成授权。
const matchingRoleKey = and(
  eq(roleGrants.roleKey, userRoles.roleKey),
  eq(exactAuthzKey(roleGrants.roleKey), exactAuthzKey(userRoles.roleKey)),
);
const siteAdminGrantPermission = and(
  inArray(roleGrants.permissionKey, SITE_ADMIN_PERMISSIONS),
  inArray(exactAuthzKey(roleGrants.permissionKey), SITE_ADMIN_PERMISSIONS),
);

/** 管理员互斥锁负责串行化；需要在锁内晚读资格的事务避免沿用旧快照。 */
export const SITE_ADMIN_TX_OPTIONS = { isolationLevel: "read committed" } as const;

export class SiteAdminInvariantError extends Error {
  constructor() {
    super("至少保留一位可以登录并管理角色的永久站点管理员");
    this.name = "SiteAdminInvariantError";
  }
}

/** 沿用同一主键查找锁住管理员互斥行，与旧版本串行化；该行本身不参与资格判定。 */
export async function lockSiteAdminInvariant(tx: AuthzTransaction): Promise<void> {
  const [row] = await tx
    .select({ key: roles.key })
    .from(roles)
    .where(eq(roles.key, "admin"))
    .limit(1)
    .for("update");
  if (!row) throw new SiteAdminInvariantError();
}

/** 管理员账号的基础条件；令牌资格继续沿用这些条件。 */
function eligibleSiteAdminAccount(tx: AuthzTransaction) {
  return and(
    userNotClosing(users.id, users.state),
    eq(users.legacyPasswordPending, false),
    isNotNull(users.passwordHash),
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
  );
}

async function globalPermissionHolders(
  tx: AuthzTransaction,
  permissionKey: (typeof SITE_ADMIN_PERMISSIONS)[number],
  userId?: number,
): Promise<Set<number>> {
  const rows = await tx
    .selectDistinct({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .innerJoin(
      roleGrants,
      and(
        matchingRoleKey,
        eq(roleGrants.permissionKey, permissionKey),
        eq(exactAuthzKey(roleGrants.permissionKey), exactAuthzKey(permissionKey)),
        eq(roleGrants.scopeId, 0),
      ),
    )
    .where(
      and(
        userId === undefined ? undefined : eq(userRoles.userId, userId),
        eq(userRoles.scopeId, 0),
        or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > NOW()`),
        eligibleSiteAdminAccount(tx),
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

/** 判断角色的全站授权能否贡献管理员资格，供锁内裁决和令牌撤权联动。 */
export async function roleHasGlobalSiteAdminGrant(
  tx: AuthzTransaction,
  roleKey: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: roleGrants.id })
    .from(roleGrants)
    .where(
      and(
        eq(roleGrants.roleKey, roleKey),
        eq(exactAuthzKey(roleGrants.roleKey), exactAuthzKey(roleKey)),
        eq(roleGrants.scopeId, 0),
        siteAdminGrantPermission,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * 在管理员互斥锁内用同一条语句判断保底资格：两项权限必须由同一可登录账号永久持有，
 * 但可以来自不同角色。throughRoleKey 仅筛出使用该角色贡献权限的候选，不限制另一项权限的来源。
 * 调用方使用读已提交，或保证加锁前没有建立可重复读快照；本查询不额外锁住其他业务表。
 */
export async function hasPermanentSiteAdmin(
  tx: AuthzTransaction,
  filter: { userId?: number; excludingUserId?: number; throughRoleKey?: string } = {},
): Promise<boolean> {
  const { userId, excludingUserId, throughRoleKey } = filter;
  const [row] = await tx
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .innerJoin(roleGrants, matchingRoleKey)
    .where(
      and(
        userId === undefined ? undefined : eq(userRoles.userId, userId),
        excludingUserId === undefined ? undefined : ne(userRoles.userId, excludingUserId),
        eq(userRoles.scopeId, 0),
        isNull(userRoles.expiresAt),
        eq(roleGrants.scopeId, 0),
        siteAdminGrantPermission,
        eligibleSiteAdminAccount(tx),
        eq(users.loginVerificationRequired, false),
        ne(users.passwordHash, ""),
      ),
    )
    .groupBy(userRoles.userId)
    .having(
      and(
        sql`COUNT(DISTINCT ${exactAuthzKey(roleGrants.permissionKey)}) = ${SITE_ADMIN_PERMISSIONS.length}`,
        throughRoleKey === undefined
          ? undefined
          : sql`SUM(CASE WHEN ${exactAuthzKey(userRoles.roleKey)} = ${exactAuthzKey(throughRoleKey)} THEN 1 ELSE 0 END) > 0`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** 封禁或申请注销会让目标失去资格，只在目标是最后一位永久管理员时拒绝。 */
export async function isLastPermanentSiteAdmin(
  tx: AuthzTransaction,
  userId: number,
): Promise<boolean> {
  return (
    (await hasPermanentSiteAdmin(tx, { userId })) &&
    !(await hasPermanentSiteAdmin(tx, { excludingUserId: userId }))
  );
}
