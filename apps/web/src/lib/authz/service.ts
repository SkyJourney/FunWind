import { cache } from "react";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  getWebDb,
  forums,
  roles,
  roleGrants,
  userRoles,
  users,
  PERMISSION_DEFINITIONS,
  type PermLevel,
} from "@funwind/db";
import { evaluate, type EvaluateResult } from "./evaluator";
import { getCurrentUser } from "@/lib/auth/session";

/**
 * 权限服务（M5）：作用域链解析、授权装载、checkPermission、派生版主。
 * 优先级与语义见 evaluator.ts / docs/AUTHZ.md。
 */

export interface AuthzUser {
  id: number | null; // null = 未登录（guest 隐式角色）
  roleKeys: string[];
  mutedActive: boolean;
}

/** 当前请求的认证上下文 → 评估器入参（请求级缓存） */
export const getAuthzContext = cache(async (): Promise<AuthzUser> => {
  const user = await getCurrentUser();
  if (!user) return { id: null, roleKeys: ["guest"], mutedActive: false };

  const db = getWebDb();
  const rows = await db
    .select({
      roleKey: userRoles.roleKey,
      expiresAt: userRoles.expiresAt,
      scopeType: userRoles.scopeType,
    })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, user.id),
        or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > NOW()`),
      ),
    );

  const roleKeys = new Set<string>(["member", ...rows.map((r) => r.roleKey)]);
  const mutedActive = rows.some((r) => r.roleKey === "muted" && r.scopeType === "global");

  return { id: user.id, roleKeys: [...roleKeys], mutedActive };
});

/** 版块作用域链：自版块沿父链向上（含自身） */
export const getScopeChain = cache(async (forumId: number): Promise<number[]> => {
  const db = getWebDb();
  const rows = await db.select({ id: forums.id, parentId: forums.parentId }).from(forums);
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
  const chain: number[] = [];
  let cur: number | undefined = forumId;
  const seen = new Set<number>();
  while (cur !== undefined && cur !== 0 && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = parentOf.get(cur);
  }
  return chain;
});

const PERM_DEF_BY_KEY = new Map(PERMISSION_DEFINITIONS.map((p) => [p.key, p]));

/** 装载用户角色在作用域链上的全部有效授权行 */
async function loadGrants(
  authz: AuthzUser,
  chain: number[],
): Promise<{ roleKey: string; permissionKey: string }[]> {
  if (authz.roleKeys.length === 0) return [];
  const db = getWebDb();
  const rows = await db
    .select({
      roleKey: roleGrants.roleKey,
      permissionKey: roleGrants.permissionKey,
      scopeType: roleGrants.scopeType,
      forumId: roleGrants.forumId,
    })
    .from(roleGrants)
    .innerJoin(
      userRoles,
      and(
        eq(userRoles.roleKey, roleGrants.roleKey),
        eq(userRoles.userId, authz.id!),
        or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > NOW()`),
      ),
    )
    .where(
      and(
        inArray(userRoles.roleKey, authz.roleKeys),
        or(
          eq(roleGrants.scopeType, "global"),
          chain.length > 0
            ? and(eq(roleGrants.scopeType, "forum"), inArray(roleGrants.forumId, chain))
            : sql`FALSE`,
        ),
        or(
          // 授权作用域与绑定作用域一致（全局授权需全局绑定；版块授权需对应版块绑定或任意绑定）
          eq(roleGrants.scopeType, userRoles.scopeType),
          eq(userRoles.scopeType, "global"),
        ),
      ),
    );
  return rows.map((r) => ({ roleKey: r.roleKey, permissionKey: r.permissionKey }));
}

/** 权限检查主入口（userId=null 走 guest 隐式角色） */
export async function checkPermission(
  userId: number | null,
  permissionKey: string,
  ctx: { forumId?: number } = {},
): Promise<EvaluateResult> {
  const def = PERM_DEF_BY_KEY.get(permissionKey);
  if (!def) return { allowed: false, reason: `未知权限点: ${permissionKey}` };

  const authz =
    userId === null
      ? { id: null, roleKeys: ["guest"], mutedActive: false }
      : await getAuthzContext();

  const chain = ctx.forumId ? await getScopeChain(ctx.forumId) : [];
  const grants = await loadGrants(authz, chain);

  return evaluate({
    roleKeys: authz.roleKeys,
    mutedActive: authz.mutedActive,
    grants,
    permissionKey,
  });
}

/** 便捷断言：DENY 时抛错（Server Action 入口用） */
export async function requirePermission(
  userId: number | null,
  permissionKey: string,
  ctx: { forumId?: number } = {},
): Promise<void> {
  const r = await checkPermission(userId, permissionKey, ctx);
  if (!r.allowed) throw new Error(`权限不足: ${permissionKey}（${r.reason}）`);
}

/** 分级便捷：需要 forum 域某级别（manage ⊃ write ⊃ read 由评估器隐含） */
export async function requireForumLevel(
  userId: number | null,
  level: PermLevel,
  forumId: number,
): Promise<void> {
  await requirePermission(userId, `forum.${level}`, { forumId });
}

/** 级别检查（不抛错，页面渲染分支用） */
export async function hasForumLevel(
  userId: number | null,
  level: PermLevel,
  forumId: number,
): Promise<boolean> {
  const r = await checkPermission(userId, `forum.${level}`, { forumId });
  return r.allowed;
}

/**
 * 派生版主（M5 语义：在版块作用域链上持有 forum.manage/write 的用户，含父链继承标注）。
 * 版块级授权统一走角色——查询 = 授权角色 ∩ 持有该角色的用户。
 */
export async function getForumModerators(
  forumId: number,
): Promise<{ userId: number; username: string; viaParent: boolean }[]> {
  const db = getWebDb();
  const chain = await getScopeChain(forumId);
  if (chain.length === 0) return [];

  const grants = await db
    .select({ roleKey: roleGrants.roleKey, forumId: roleGrants.forumId })
    .from(roleGrants)
    .where(
      and(
        inArray(roleGrants.permissionKey, ["forum.manage", "forum.write"]),
        eq(roleGrants.scopeType, "forum"),
        inArray(roleGrants.forumId, chain),
      ),
    );

  if (grants.length === 0) return [];
  const roleKeys = [...new Set(grants.map((g) => g.roleKey))];

  const holders = await db
    .select({ userId: userRoles.userId, roleKey: userRoles.roleKey, username: users.username })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(
        inArray(userRoles.roleKey, roleKeys),
        or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > NOW()`),
      ),
    );

  const seen = new Map<number, { userId: number; username: string; viaParent: boolean }>();
  for (const h of holders) {
    if (!seen.has(h.userId)) {
      seen.set(h.userId, { userId: h.userId, username: h.username, viaParent: false });
    }
  }
  return [...seen.values()];
}

// ---------- 管理界面查询与操作（/admin 最小版；完整后台归 M9）----------

export async function listRoles(): Promise<
  { key: string; name: string; kind: string; description: string }[]
> {
  const db = getWebDb();
  return db
    .select({ key: roles.key, name: roles.name, kind: roles.kind, description: roles.description })
    .from(roles)
    .orderBy(roles.kind, roles.key);
}

export async function listPermissions() {
  // 词汇表单一事实源（迁移与评估器同源），避免手写反引号查询
  return PERMISSION_DEFINITIONS.map((p) => ({
    key: p.key,
    resource: p.resource,
    level: p.level,
    description: p.description,
  }));
}

export async function getRoleGrants(
  roleKey: string,
): Promise<{ permissionKey: string; scopeType: string; forumId: number | null }[]> {
  const db = getWebDb();
  return db
    .select({
      permissionKey: roleGrants.permissionKey,
      scopeType: roleGrants.scopeType,
      forumId: roleGrants.forumId,
    })
    .from(roleGrants)
    .where(eq(roleGrants.roleKey, roleKey));
}

export async function grantRolePermission(
  roleKey: string,
  permissionKey: string,
  forumId: number | null,
): Promise<void> {
  const db = getWebDb();
  await db
    .insert(roleGrants)
    .values({
      roleKey,
      permissionKey,
      scopeType: forumId === null ? "global" : "forum",
      forumId,
    })
    .onDuplicateKeyUpdate({ set: { forumId } });
}

export async function revokeRolePermission(
  roleKey: string,
  permissionKey: string,
  forumId: number | null,
): Promise<void> {
  const db = getWebDb();
  const scopeType = forumId === null ? "global" : "forum";
  await db
    .delete(roleGrants)
    .where(
      and(
        eq(roleGrants.roleKey, roleKey),
        eq(roleGrants.permissionKey, permissionKey),
        eq(roleGrants.scopeType, scopeType),
        forumId === null ? isNull(roleGrants.forumId) : eq(roleGrants.forumId, forumId),
      ),
    );
}

export async function createCustomRole(
  key: string,
  name: string,
  description: string,
): Promise<void> {
  const db = getWebDb();
  await db
    .insert(roles)
    .values({ key, name, kind: "custom", description })
    .onDuplicateKeyUpdate({ set: { name, description } });
}

export async function deleteCustomRole(key: string): Promise<void> {
  if (["guest", "member", "muted", "admin"].includes(key)) {
    throw new Error("内置角色不可删除");
  }
  const db = getWebDb();
  await db.delete(roles).where(eq(roles.key, key));
  await db.delete(roleGrants).where(eq(roleGrants.roleKey, key));
  await db.delete(userRoles).where(eq(userRoles.roleKey, key));
}
