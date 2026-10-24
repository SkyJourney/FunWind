import { and, eq, inArray } from "drizzle-orm";
import {
  PERMISSION_DEFINITIONS,
  getWebDb,
  roleGrants,
  roles,
  userRoles,
  users,
  type PermissionDef,
} from "@funwind/db";
import { writeAudit } from "@/lib/audit";
import { emit } from "@/modules/kernel/bus";
import type { EventPayloads } from "@/modules/kernel/types";
import { sql } from "drizzle-orm";
import { getAuthzSnapshot, invalidateAuthzSnapshot } from "./snapshot";

/**
 * 授权管理（/admin 最小版；完整后台归 M9）。
 * 每个写操作：先校验 → 在**同一事务**里改库并写 audit_log → 提交后失效规则快照。
 * 校验失败抛 AdminError（消息可直接展示给管理员）。
 */

export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminError";
  }
}

export interface AdminDeps {
  /** 覆盖事件派发（单测注入；缺省走内核总线） */
  emitter?: (name: "role.changed", payload: EventPayloads["role.changed"]) => Promise<unknown>;
}

/** 提交后派发 role.changed；失败只记日志，不影响已提交的授权变更 */
async function emitRoleChanged(deps: AdminDeps, payload: EventPayloads["role.changed"]) {
  try {
    await (deps.emitter ?? ((n, p) => emit(n, p, { source: "admin" })))("role.changed", payload);
  } catch (e) {
    console.error("[authz] role.changed 派发失败（变更已提交）:", e);
  }
}

export interface AdminActor {
  userId: number;
  ip: string | null;
}

const ROLE_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** 内置角色：不可创建同名、不可删除、不可绑定到用户（guest/member 为隐式角色） */
const BUILTIN_ROLES = new Set(["guest", "member", "admin"]);
const KNOWN_PERMISSIONS = new Set(PERMISSION_DEFINITIONS.map((p) => p.key));
/** 提权护栏：这些权限点不得全局授予隐式角色（否则全体会员/游客都成了管理员或版主） */
const PRIVILEGED = (key: string) =>
  key === "forum.moderate" ||
  key === "site.admin" ||
  key === "user.viewIp" ||
  key.startsWith("admin.");
/** 防自锁：admin 的这两个全局授权不可撤销，否则后台无人能再进入 */
const ADMIN_LOCKED = new Set(["site.admin", "admin.roles"]);

async function requireRole(key: string): Promise<{ key: string; kind: string }> {
  const rows = await getWebDb()
    .select({ key: roles.key, kind: roles.kind })
    .from(roles)
    .where(eq(roles.key, key))
    .limit(1);
  if (!rows[0]) throw new AdminError(`角色不存在: ${key}`);
  return rows[0];
}

async function requireScope(scopeId: number): Promise<void> {
  if (!Number.isInteger(scopeId) || scopeId < 0) throw new AdminError("作用域无效");
  if (scopeId === 0) return;
  if (!(await getAuthzSnapshot()).tree.has(scopeId)) throw new AdminError(`版块不存在: ${scopeId}`);
}

// ---------- 查询 ----------

export async function listRoles(): Promise<
  { key: string; name: string; kind: string; description: string }[]
> {
  return getWebDb()
    .select({ key: roles.key, name: roles.name, kind: roles.kind, description: roles.description })
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

// ---------- 授权 ----------

export async function grantRolePermission(
  actor: AdminActor,
  roleKey: string,
  permissionKey: string,
  scopeId: number,
): Promise<void> {
  await requireRole(roleKey);
  if (!KNOWN_PERMISSIONS.has(permissionKey)) {
    throw new AdminError(`未知权限点: ${permissionKey}`);
  }
  await requireScope(scopeId);
  if ((roleKey === "guest" || roleKey === "member") && scopeId === 0 && PRIVILEGED(permissionKey)) {
    throw new AdminError(
      `不得把 ${permissionKey} 全局授予隐式角色 ${roleKey}（会让全体用户获得管理/版主权）`,
    );
  }

  await getWebDb().transaction(async (tx) => {
    const exists = await tx
      .select({ id: roleGrants.id })
      .from(roleGrants)
      .where(
        and(
          eq(roleGrants.roleKey, roleKey),
          eq(roleGrants.permissionKey, permissionKey),
          eq(roleGrants.scopeId, scopeId),
        ),
      )
      .limit(1);
    if (exists[0]) return; // 幂等：已存在不重复写、不重复审计
    await tx.insert(roleGrants).values({ roleKey, permissionKey, scopeId });
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "grant.add",
      targetType: "role",
      targetId: roleKey,
      after: { permissionKey, scopeId },
      ip: actor.ip,
    });
  });
  invalidateAuthzSnapshot();
}

export async function revokeRolePermission(
  actor: AdminActor,
  roleKey: string,
  permissionKey: string,
  scopeId: number,
): Promise<void> {
  await requireRole(roleKey);
  if (roleKey === "admin" && scopeId === 0 && ADMIN_LOCKED.has(permissionKey)) {
    throw new AdminError(`不可撤销 admin 的 ${permissionKey}（防止后台被锁死）`);
  }
  await getWebDb().transaction(async (tx) => {
    const rows = await tx
      .select({ id: roleGrants.id })
      .from(roleGrants)
      .where(
        and(
          eq(roleGrants.roleKey, roleKey),
          eq(roleGrants.permissionKey, permissionKey),
          eq(roleGrants.scopeId, scopeId),
        ),
      );
    if (rows.length === 0) return;
    await tx.delete(roleGrants).where(
      inArray(
        roleGrants.id,
        rows.map((r) => r.id),
      ),
    );
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "grant.revoke",
      targetType: "role",
      targetId: roleKey,
      before: { permissionKey, scopeId },
      ip: actor.ip,
    });
  });
  invalidateAuthzSnapshot();
}

// ---------- 角色 ----------

export async function createCustomRole(
  actor: AdminActor,
  key: string,
  name: string,
  description: string,
): Promise<void> {
  if (!ROLE_KEY_RE.test(key)) throw new AdminError("角色键需为 kebab-case（小写字母/数字/连字符）");
  if (BUILTIN_ROLES.has(key)) throw new AdminError(`${key} 是内置角色键，不能使用`);
  await getWebDb().transaction(async (tx) => {
    const exists = await tx
      .select({ key: roles.key })
      .from(roles)
      .where(eq(roles.key, key))
      .limit(1);
    // 只 insert，不 upsert：同名角色一律拒绝，杜绝“创建”变成改写既有角色（含内置角色）
    if (exists[0]) throw new AdminError(`角色已存在: ${key}`);
    await tx.insert(roles).values({ key, name: name || key, kind: "custom", description });
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "role.create",
      targetType: "role",
      targetId: key,
      after: { name: name || key, description },
      ip: actor.ip,
    });
  });
  invalidateAuthzSnapshot();
}

export async function deleteCustomRole(actor: AdminActor, key: string): Promise<void> {
  const role = await requireRole(key);
  if (role.kind === "builtin" || BUILTIN_ROLES.has(key)) throw new AdminError("内置角色不可删除");
  await getWebDb().transaction(async (tx) => {
    const grants = await tx.select().from(roleGrants).where(eq(roleGrants.roleKey, key));
    const holders = await tx.select().from(userRoles).where(eq(userRoles.roleKey, key));
    await tx.delete(roleGrants).where(eq(roleGrants.roleKey, key));
    await tx.delete(userRoles).where(eq(userRoles.roleKey, key));
    await tx.delete(roles).where(eq(roles.key, key));
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "role.delete",
      targetType: "role",
      targetId: key,
      before: { grants: grants.length, holders: holders.length },
      ip: actor.ip,
    });
  });
  invalidateAuthzSnapshot();
}

// ---------- 用户角色绑定 ----------

export async function assignUserRole(
  actor: AdminActor,
  userId: number,
  roleKey: string,
  scopeId: number,
  expiresAt: string | null = null,
  deps: AdminDeps = {},
): Promise<void> {
  if (roleKey === "guest" || roleKey === "member") {
    throw new AdminError(`${roleKey} 是隐式角色，不能绑定到用户`);
  }
  await requireRole(roleKey);
  await requireScope(scopeId);
  const target = await getWebDb()
    .select({ id: users.id, state: users.state })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target[0] || target[0].state !== "active")
    throw new AdminError(`用户不存在或已注销: ${userId}`);

  await getWebDb().transaction(async (tx) => {
    const exists = await tx
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(userRoles.roleKey, roleKey),
          eq(userRoles.scopeId, scopeId),
        ),
      )
      .limit(1);
    if (exists[0]) {
      await tx.update(userRoles).set({ expiresAt }).where(eq(userRoles.id, exists[0].id));
    } else {
      await tx.insert(userRoles).values({
        userId,
        roleKey,
        scopeId,
        expiresAt,
        grantedBy: actor.userId,
        grantedAt: sql`NOW()`,
      });
    }
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "user_role.assign",
      targetType: "user",
      targetId: userId,
      after: { roleKey, scopeId, expiresAt },
      ip: actor.ip,
    });
  });
  await emitRoleChanged(deps, {
    userId,
    roleKey,
    scopeId,
    action: "granted",
    operatorId: actor.userId,
  });
}

export async function revokeUserRole(
  actor: AdminActor,
  userId: number,
  roleKey: string,
  scopeId: number,
  deps: AdminDeps = {},
): Promise<void> {
  let removed = false;
  await getWebDb().transaction(async (tx) => {
    const rows = await tx
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(userRoles.roleKey, roleKey),
          eq(userRoles.scopeId, scopeId),
        ),
      );
    if (rows.length === 0) return;
    await tx.delete(userRoles).where(
      inArray(
        userRoles.id,
        rows.map((r) => r.id),
      ),
    );
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "user_role.revoke",
      targetType: "user",
      targetId: userId,
      before: { roleKey, scopeId },
      ip: actor.ip,
    });
    removed = true;
  });
  // 绑定本来就不存在时是幂等空操作：不写审计、不派发事件
  if (removed) {
    await emitRoleChanged(deps, {
      userId,
      roleKey,
      scopeId,
      action: "revoked",
      operatorId: actor.userId,
    });
  }
}
