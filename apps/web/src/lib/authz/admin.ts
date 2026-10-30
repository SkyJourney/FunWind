import { and, eq, inArray } from "drizzle-orm";
import {
  PERMISSION_DEFINITIONS,
  accountDeletionRequests,
  getWebDb,
  roleGrants,
  roles,
  userRoles,
  users,
  type PermissionDef,
} from "@funwind/db";
import { writeAudit } from "@/lib/audit";
import { parseDbDateTime } from "@/lib/datetime";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
  type OutboxEmitter,
} from "@/lib/events/outbox";
import type { EventName, EventPayloads } from "@/modules/kernel/types";
import { sql } from "drizzle-orm";
import { getAuthzSnapshot, invalidateAuthzSnapshot } from "./snapshot";
import { isTeamMembershipRole } from "./team-role-mapping";
import {
  assertEffectiveSiteAdminRemains,
  lockSiteAdminInvariant,
  SiteAdminInvariantError,
  type AuthzTransaction,
} from "./site-admin-invariant";

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

/** 提交后派发事务内登记的角色事件；失败留在 outbox 等补派 */
async function dispatchRoleChanges(
  events: readonly EnqueuedEvent[],
  deps: AdminDeps,
): Promise<void> {
  const emitter: OutboxEmitter | undefined = deps.emitter
    ? async <K extends EventName>(name: K, payload: EventPayloads[K]) => {
        if (name === "role.changed") {
          return deps.emitter!("role.changed", payload as EventPayloads["role.changed"]);
        }
        return undefined;
      }
    : undefined;
  await dispatchOutboxRows(events, emitter ? { emitter } : {});
  await sweepPending();
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

function isFutureExpiration(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month! - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) {
    return false;
  }
  const instant = parseDbDateTime(value).getTime();
  return Number.isFinite(instant) && instant > Date.now();
}

async function assertSiteAdminRemains(tx: AuthzTransaction): Promise<void> {
  try {
    await assertEffectiveSiteAdminRemains(tx);
  } catch (error) {
    if (error instanceof SiteAdminInvariantError) throw new AdminError(error.message);
    throw error;
  }
}

async function requireRole(key: string): Promise<{ key: string; kind: string; isPublic: boolean }> {
  const rows = await getWebDb()
    .select({ key: roles.key, kind: roles.kind, isPublic: roles.isPublic })
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
  await requireRole(roleKey);
  if (BUILTIN_ROLES.has(roleKey) && isPublic) throw new AdminError("内置角色不可公开展示");

  await getWebDb().transaction(async (tx) => {
    await lockSiteAdminInvariant(tx);
    const [role] = await tx
      .select({ kind: roles.kind, isPublic: roles.isPublic })
      .from(roles)
      .where(eq(roles.key, roleKey))
      .limit(1)
      .for("update");
    if (!role) throw new AdminError(`角色不存在: ${roleKey}`);
    if (role.kind === "builtin" && isPublic) throw new AdminError("内置角色不可公开展示");
    if (role.isPublic === isPublic) return;

    if (isPublic) {
      const grants = await tx
        .select({ permissionKey: roleGrants.permissionKey })
        .from(roleGrants)
        .where(eq(roleGrants.roleKey, roleKey));
      if (
        grants.some(
          ({ permissionKey }) =>
            permissionKey === "site.admin" ||
            permissionKey === "user.viewIp" ||
            permissionKey.startsWith("admin."),
        )
      ) {
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

// ---------- 授权 ----------

export async function grantRolePermission(
  actor: AdminActor,
  roleKey: string,
  permissionKey: string,
  scopeId: number,
): Promise<void> {
  const role = await requireRole(roleKey);
  if (!KNOWN_PERMISSIONS.has(permissionKey)) {
    throw new AdminError(`未知权限点: ${permissionKey}`);
  }
  if (
    role.isPublic &&
    (permissionKey === "site.admin" ||
      permissionKey === "user.viewIp" ||
      permissionKey.startsWith("admin."))
  ) {
    throw new AdminError("公开身份不能授予后台管理权限");
  }
  await requireScope(scopeId);
  if ((roleKey === "guest" || roleKey === "member") && scopeId === 0 && PRIVILEGED(permissionKey)) {
    throw new AdminError(
      `不得把 ${permissionKey} 全局授予隐式角色 ${roleKey}（会让全体用户获得管理/版主权）`,
    );
  }

  await getWebDb().transaction(async (tx) => {
    await lockSiteAdminInvariant(tx);
    const [currentRole] = await tx
      .select({ isPublic: roles.isPublic })
      .from(roles)
      .where(eq(roles.key, roleKey))
      .limit(1)
      .for("update");
    if (!currentRole) throw new AdminError(`角色不存在: ${roleKey}`);
    if (
      currentRole.isPublic &&
      (permissionKey === "site.admin" ||
        permissionKey === "user.viewIp" ||
        permissionKey.startsWith("admin."))
    ) {
      throw new AdminError("公开身份不能授予后台管理权限");
    }
    // 幂等：先查后插在并发（双击 / 重复提交）下两边都看不到对方，第二个 INSERT 会撞唯一键抛原始错误（复查 B5）。
    // 改为 INSERT IGNORE，用 affectedRows 判断是否真的写入了——已存在则不重复写、不重复审计
    const [res] = (await tx
      .insert(roleGrants)
      .ignore()
      .values({ roleKey, permissionKey, scopeId })) as unknown as [{ affectedRows: number }];
    if (res.affectedRows === 0) return;
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
    await lockSiteAdminInvariant(tx);
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
    if (scopeId === 0 && (permissionKey === "site.admin" || permissionKey === "admin.roles")) {
      await assertSiteAdminRemains(tx);
    }
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
  if (isTeamMembershipRole(key)) throw new AdminError("固定团队角色不能删除");
  await getWebDb().transaction(async (tx) => {
    await lockSiteAdminInvariant(tx);
    const grants = await tx.select().from(roleGrants).where(eq(roleGrants.roleKey, key));
    const holders = await tx.select().from(userRoles).where(eq(userRoles.roleKey, key));
    const removesAdminGrant = grants.some(
      (grant) =>
        grant.scopeId === 0 &&
        (grant.permissionKey === "site.admin" || grant.permissionKey === "admin.roles"),
    );
    await tx.delete(roleGrants).where(eq(roleGrants.roleKey, key));
    await tx.delete(userRoles).where(eq(userRoles.roleKey, key));
    await tx.delete(roles).where(eq(roles.key, key));
    if (removesAdminGrant) await assertSiteAdminRemains(tx);
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
  expiresAt: string | null,
  reason: string,
  deps: AdminDeps = {},
): Promise<void> {
  if (roleKey === "guest" || roleKey === "member") {
    throw new AdminError(`${roleKey} 是隐式角色，不能绑定到用户`);
  }
  if (expiresAt !== null && !isFutureExpiration(expiresAt)) {
    throw new AdminError("到期时间必须是有效的未来北京时间");
  }
  if (isTeamMembershipRole(roleKey)) {
    throw new AdminError("团队角色必须通过团队成员服务授予");
  }
  await requireRole(roleKey);
  await requireScope(scopeId);
  const why = reason.trim();
  if (!why) throw new AdminError("必须填写授予理由");
  if (why.length > 255) throw new AdminError("授予理由不能超过 255 个字符");
  const enqueued: EnqueuedEvent[] = [];
  await getWebDb().transaction(async (tx) => {
    enqueued.length = 0;
    await lockSiteAdminInvariant(tx);
    const [target] = await tx
      .select({ id: users.id, state: users.state })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    if (!target || target.state !== "active") {
      throw new AdminError(`用户不存在或已注销: ${userId}`);
    }
    const [closure] = await tx
      .select({ id: accountDeletionRequests.id })
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.userId, userId),
          inArray(accountDeletionRequests.status, ["pending", "completed"]),
        ),
      )
      .limit(1);
    if (closure) throw new AdminError(`用户正在注销或已注销: ${userId}`);
    await tx
      .insert(userRoles)
      .values({
        userId,
        roleKey,
        scopeId,
        expiresAt,
        grantedBy: actor.userId,
        grantedAt: sql`NOW()`,
      })
      .onDuplicateKeyUpdate({ set: { expiresAt } });
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "user_role.assign",
      targetType: "user",
      targetId: userId,
      after: { roleKey, scopeId, expiresAt, reason: why },
      ip: actor.ip,
    });
    enqueued.push(
      await enqueueEventInTx(
        tx,
        "role.changed",
        { userId, roleKey, scopeId, action: "granted", operatorId: actor.userId, expiresAt },
        { actorId: actor.userId, source: "admin" },
      ),
    );
  });
  await dispatchRoleChanges(enqueued, deps);
}

export async function revokeUserRole(
  actor: AdminActor,
  userId: number,
  roleKey: string,
  scopeId: number,
  reason: string,
  deps: AdminDeps = {},
): Promise<void> {
  if (isTeamMembershipRole(roleKey)) {
    throw new AdminError("团队角色必须通过团队成员服务收回");
  }
  const why = reason.trim();
  if (!why) throw new AdminError("必须填写撤销理由");
  if (why.length > 255) throw new AdminError("撤销理由不能超过 255 个字符");
  const enqueued: EnqueuedEvent[] = [];
  await getWebDb().transaction(async (tx) => {
    enqueued.length = 0;
    await lockSiteAdminInvariant(tx);
    const rows = await tx
      .select({ id: userRoles.id, expiresAt: userRoles.expiresAt })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(userRoles.roleKey, roleKey),
          eq(userRoles.scopeId, scopeId),
        ),
      );
    if (rows.length === 0) return;
    const adminGrants =
      scopeId === 0
        ? await tx
            .select({ id: roleGrants.id })
            .from(roleGrants)
            .where(
              and(
                eq(roleGrants.roleKey, roleKey),
                eq(roleGrants.scopeId, 0),
                inArray(roleGrants.permissionKey, ["site.admin", "admin.roles"]),
              ),
            )
        : [];
    await tx.delete(userRoles).where(
      inArray(
        userRoles.id,
        rows.map((r) => r.id),
      ),
    );
    if (adminGrants.length > 0) await assertSiteAdminRemains(tx);
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "user_role.revoke",
      targetType: "user",
      targetId: userId,
      before: { roleKey, scopeId, expiresAt: rows[0]?.expiresAt ?? null },
      after: { reason: why },
      ip: actor.ip,
    });
    enqueued.push(
      await enqueueEventInTx(
        tx,
        "role.changed",
        {
          userId,
          roleKey,
          scopeId,
          action: "revoked",
          operatorId: actor.userId,
          expiresAt: rows[0]?.expiresAt ?? null,
        },
        { actorId: actor.userId, source: "admin" },
      ),
    );
  });
  if (enqueued.length > 0) await dispatchRoleChanges(enqueued, deps);
}
