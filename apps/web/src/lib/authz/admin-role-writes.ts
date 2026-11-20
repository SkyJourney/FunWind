import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import {
  affectedRowsOf,
  getWebDb,
  PERMISSION_DEFINITIONS,
  roleGrants,
  roles,
  userRoles,
} from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import { isDuplicateKey } from "@/lib/auth/register";
import { revokeAdminApiTokensIfNotSiteAdmin } from "@/lib/manage/tokens";
import type { ModerationApiTrace, ModerationWriteDenial } from "@/lib/moderation/contents";
import { AdminError } from "./admin-error";
import {
  adjudicatePermanentSiteAdminRemains,
  apiTraceFields,
  auditViaFields,
  BUILTIN_ROLES,
  checkScope,
  findRole,
  isBackstagePermission,
  isCanonicalRoleKey,
  lockExistingRole,
  roleNotFound,
  type AdminActor,
  type LockedRole,
} from "./admin-shared";
import {
  exactAuthzKey,
  hasPermanentSiteAdmin,
  SITE_ADMIN_PERMISSIONS,
  SITE_ADMIN_TX_OPTIONS,
} from "./site-admin-invariant";
import { invalidateAuthzSnapshot } from "./snapshot";
import { isTeamMembershipRole } from "./team-role-mapping";

const KNOWN_PERMISSIONS = new Set(PERMISSION_DEFINITIONS.map((p) => p.key));
/** 提权护栏：这些权限点不得全局授予隐式角色（否则全体会员/游客都成了管理员或版主） */
function checkImplicitGrant(
  roleKey: string,
  permissionKey: string,
  scopeId: number,
): ModerationWriteDenial<"implicit_guard"> | null {
  if (
    (roleKey === "guest" || roleKey === "member") &&
    scopeId === 0 &&
    (permissionKey === "forum.moderate" || isBackstagePermission(permissionKey))
  ) {
    return {
      ok: false,
      code: "implicit_guard",
      message: `不得把 ${permissionKey} 全局授予隐式角色 ${roleKey}（会让全体用户获得管理/版主权）`,
    };
  }
  return null;
}
/** 防自锁：admin 的这两个全局授权不可撤销，否则后台无人能再进入 */
const ADMIN_LOCKED = new Set<string>(SITE_ADMIN_PERMISSIONS);

// ---------- 授权 ----------

/** 授予角色权限的拒绝码（对应既有 AdminError 文案分类）。 */
export type RoleGrantCode =
  | "not_found"
  | "unknown_permission"
  | "public_admin"
  | "bad_scope"
  | "scope_not_found"
  | "implicit_guard";
export type RoleGrantDenial = ModerationWriteDenial<RoleGrantCode>;

/** 授予角色权限的事务外校验计划（后台与 REST 共享）。 */
type RoleGrantPlan = { roleKey: string; permissionKey: string; scopeId: number };

/** 后台保留输入预检顺序；REST 将可变状态检查留到幂等回放之后。 */
export async function planRoleGrant(
  input: RoleGrantPlan,
  precheck = true,
): Promise<{ ok: true; plan: RoleGrantPlan } | RoleGrantDenial> {
  const role = precheck ? await findRole(input.roleKey) : null;
  if (precheck && !role) return roleNotFound(input.roleKey);
  if (!KNOWN_PERMISSIONS.has(input.permissionKey)) {
    return {
      ok: false,
      code: "unknown_permission",
      message: `未知权限点: ${input.permissionKey}`,
    };
  }
  if (role?.isPublic && isBackstagePermission(input.permissionKey)) {
    return { ok: false, code: "public_admin", message: "公开身份不能授予后台管理权限" };
  }
  if (precheck) {
    const scopeDenial = await checkScope(input.scopeId);
    if (scopeDenial) return { ok: false, ...scopeDenial };
  }
  return (
    checkImplicitGrant(role?.key ?? input.roleKey, input.permissionKey, input.scopeId) ?? {
      ok: true,
      plan: { ...input },
    }
  );
}

/** 锁段（后台与 REST 共享）：锁站点管理员不变量行 + 锁角色行（存在性）；不做可变状态裁决。 */
export async function lockRoleGrant(
  tx: DbTx,
  plan: RoleGrantPlan,
): Promise<{ ok: true; role: Pick<LockedRole, "key" | "isPublic"> } | RoleGrantDenial> {
  const role = await lockExistingRole(tx, plan.roleKey);
  if (!role || !isCanonicalRoleKey(role.key)) return roleNotFound(plan.roleKey);
  // 守卫和写入都用锁定行的规范键，不沿用可能按排序规则命中的输入别名。
  const denial = checkImplicitGrant(role.key, plan.permissionKey, plan.scopeId);
  if (denial) return denial;
  return { ok: true, role };
}

/** 执行段（后台与 REST 共享）：公开身份护栏裁决（锁内最新 isPublic）+ INSERT IGNORE 幂等写入 + 审计。 */
export async function applyRoleGrant(
  tx: DbTx,
  actor: AdminActor,
  plan: RoleGrantPlan,
  locked: Pick<LockedRole, "key" | "isPublic">,
  trace?: ModerationApiTrace,
): Promise<
  | {
      ok: true;
      data: { roleKey: string; permissionKey: string; scopeId: number; changed: boolean };
    }
  | RoleGrantDenial
> {
  if (locked.isPublic && isBackstagePermission(plan.permissionKey)) {
    return { ok: false, code: "public_admin", message: "公开身份不能授予后台管理权限" };
  }
  const scopeDenial = await checkScope(plan.scopeId, tx);
  if (scopeDenial) return { ok: false, ...scopeDenial };
  const roleKey = locked.key;
  // 依赖唯一键插入，重复提交只写一条授权和一条审计。
  const result = await tx.insert(roleGrants).ignore().values({
    roleKey,
    permissionKey: plan.permissionKey,
    scopeId: plan.scopeId,
  });
  if (affectedRowsOf(result) === 0) {
    return {
      ok: true,
      data: {
        roleKey,
        permissionKey: plan.permissionKey,
        scopeId: plan.scopeId,
        changed: false,
      },
    };
  }
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "grant.add",
    targetType: "role",
    targetId: roleKey,
    after: {
      permissionKey: plan.permissionKey,
      scopeId: plan.scopeId,
      ...auditViaFields(actor),
      ...apiTraceFields(trace),
    },
    ip: actor.ip,
  });
  return {
    ok: true,
    data: {
      roleKey,
      permissionKey: plan.permissionKey,
      scopeId: plan.scopeId,
      changed: true,
    },
  };
}

/** 授予角色权限（后台入口）：先校验 → 同事务写入并审计 → 提交后失效规则快照。 */
export async function grantRolePermission(
  actor: AdminActor,
  roleKey: string,
  permissionKey: string,
  scopeId: number,
): Promise<void> {
  const planned = await planRoleGrant({ roleKey, permissionKey, scopeId });
  if (!planned.ok) throw new AdminError(planned.message ?? planned.code);
  await getWebDb().transaction(async (tx) => {
    const locked = await lockRoleGrant(tx, planned.plan);
    if (!locked.ok) throw new AdminError(locked.message ?? locked.code);
    const applied = await applyRoleGrant(tx, actor, planned.plan, locked.role);
    if (!applied.ok) throw new AdminError(applied.message ?? applied.code);
  });
  invalidateAuthzSnapshot();
}

/** 撤销角色权限的拒绝码（对应既有 AdminError 文案分类）。 */
export type RoleRevokeCode = "not_found" | "admin_locked" | "last_admin";
export type RoleRevokeDenial = ModerationWriteDenial<RoleRevokeCode>;

/** 撤销角色权限的事务外校验计划（后台与 REST 共享）。 */
type RoleRevokePlan = { roleKey: string; permissionKey: string; scopeId: number };

/** 检查内置管理员不可撤销的全局授权。 */
function checkAdminGrantRevoke(
  input: RoleRevokePlan,
): ModerationWriteDenial<"admin_locked"> | null {
  if (input.roleKey !== "admin" || input.scopeId !== 0 || !ADMIN_LOCKED.has(input.permissionKey)) {
    return null;
  }
  return {
    ok: false,
    code: "admin_locked",
    message: `不可撤销 admin 的 ${input.permissionKey}（防止后台被锁死）`,
  };
}

/** 后台保留角色存在性预检；REST 在访问幂等记录之后锁定角色。 */
export async function planRoleRevoke(
  input: RoleRevokePlan,
  precheck = true,
): Promise<{ ok: true; plan: RoleRevokePlan } | RoleRevokeDenial> {
  const role = precheck ? await findRole(input.roleKey) : null;
  if (precheck && !role) return roleNotFound(input.roleKey);
  return (
    checkAdminGrantRevoke({ ...input, roleKey: role?.key ?? input.roleKey }) ?? {
      ok: true,
      plan: { ...input },
    }
  );
}

/** 执行段（后台与 REST 共享）：授权行存在性裁决 + 删除 + last-admin 裁决 + 撤权联动 + 审计。 */
export async function applyRoleRevoke(
  tx: DbTx,
  actor: AdminActor,
  plan: RoleRevokePlan,
  trace?: ModerationApiTrace,
): Promise<
  | {
      ok: true;
      data: { roleKey: string; permissionKey: string; scopeId: number; changed: boolean };
    }
  | RoleRevokeDenial
> {
  const rows = await tx
    .select({
      id: roleGrants.id,
      roleKey: roleGrants.roleKey,
      permissionKey: roleGrants.permissionKey,
    })
    .from(roleGrants)
    .where(
      and(
        eq(roleGrants.roleKey, plan.roleKey),
        eq(roleGrants.permissionKey, plan.permissionKey),
        eq(roleGrants.scopeId, plan.scopeId),
      ),
    );
  if (rows.length === 0) {
    return {
      ok: true,
      data: {
        roleKey: plan.roleKey,
        permissionKey: plan.permissionKey,
        scopeId: plan.scopeId,
        changed: false,
      },
    };
  }
  // 仍允许定位并清理历史行；用实际被删除的原始键判定该授权是否生效。
  const { roleKey, permissionKey } = rows[0];
  const guard = checkAdminGrantRevoke({ ...plan, roleKey, permissionKey });
  if (guard) return guard;
  const removesAdminGrant = plan.scopeId === 0 && ADMIN_LOCKED.has(permissionKey);
  const affectsPermanentAdmin =
    removesAdminGrant && (await hasPermanentSiteAdmin(tx, { throughRoleKey: roleKey }));
  await tx.delete(roleGrants).where(
    inArray(
      roleGrants.id,
      rows.map((r) => r.id),
    ),
  );
  if (affectsPermanentAdmin) {
    const denial = await adjudicatePermanentSiteAdminRemains(tx);
    if (denial) return denial;
  }
  if (removesAdminGrant) {
    // M20 撤权联动：该角色全体全站持有人都可能因此失去令牌资格，逐人复核。
    const holders = await tx
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.roleKey, roleKey),
          eq(exactAuthzKey(userRoles.roleKey), exactAuthzKey(roleKey)),
          eq(userRoles.scopeId, 0),
        ),
      );
    for (const holder of holders) {
      await revokeAdminApiTokensIfNotSiteAdmin(tx, holder.userId, {
        actorId: actor.userId,
        via: actor.via ?? "admin",
        ...(trace ?? {}),
      });
    }
  }
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "grant.revoke",
    targetType: "role",
    targetId: plan.roleKey,
    before: { permissionKey: plan.permissionKey, scopeId: plan.scopeId },
    ...(actor.via || trace
      ? { after: { ...auditViaFields(actor), ...apiTraceFields(trace) } }
      : {}),
    ip: actor.ip,
  });
  return {
    ok: true,
    data: {
      roleKey: plan.roleKey,
      permissionKey: plan.permissionKey,
      scopeId: plan.scopeId,
      changed: true,
    },
  };
}

/** 撤销角色权限（后台入口）：先校验 → 同事务写入并审计 → 提交后失效规则快照。 */
export async function revokeRolePermission(
  actor: AdminActor,
  roleKey: string,
  permissionKey: string,
  scopeId: number,
): Promise<void> {
  const planned = await planRoleRevoke({ roleKey, permissionKey, scopeId });
  if (!planned.ok) throw new AdminError(planned.message ?? planned.code);
  await getWebDb().transaction(async (tx) => {
    if (!(await lockExistingRole(tx, roleKey))) throw new AdminError(roleNotFound(roleKey).message);
    const applied = await applyRoleRevoke(tx, actor, planned.plan);
    if (!applied.ok) throw new AdminError(applied.message ?? applied.code);
  }, SITE_ADMIN_TX_OPTIONS);
  invalidateAuthzSnapshot();
}

// ---------- 角色 ----------

/** 创建自定义角色的拒绝码（对应既有 AdminError 文案分类）。 */
export type RoleCreateCode = "bad_key" | "builtin_key" | "already_exists";
export type RoleCreateDenial = ModerationWriteDenial<RoleCreateCode>;

/** 创建自定义角色的事务外输入计划（后台与 REST 共享）。 */
type RoleCreatePlan = { key: string; name: string; description: string };

/** 事务外输入校验（后台与 REST 共享）：kebab-case 键 + 不得占用内置角色键。 */
export function planRoleCreate(input: {
  key: string;
  name: string;
  description: string;
}): { ok: true; plan: RoleCreatePlan } | RoleCreateDenial {
  if (!isCanonicalRoleKey(input.key)) {
    return {
      ok: false,
      code: "bad_key",
      message: "角色键需为 kebab-case（小写字母/数字/连字符）",
    };
  }
  if (BUILTIN_ROLES.has(input.key)) {
    return { ok: false, code: "builtin_key", message: `${input.key} 是内置角色键，不能使用` };
  }
  return { ok: true, plan: { ...input } };
}

/** 执行段（后台与 REST 共享）：重名裁决 + 插入 + 审计；并发重名由 roles.key 唯一键兜底。 */
export async function applyRoleCreate(
  tx: DbTx,
  actor: AdminActor,
  plan: RoleCreatePlan,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; data: { key: string; name: string } } | RoleCreateDenial> {
  const name = plan.name || plan.key;
  // 由唯一键裁决重名，避免并发创建时暴露底层错误或改写已有角色。
  try {
    await tx
      .insert(roles)
      .values({ key: plan.key, name, kind: "custom", description: plan.description });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    return { ok: false, code: "already_exists", message: `角色已存在: ${plan.key}` };
  }
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "role.create",
    targetType: "role",
    targetId: plan.key,
    after: {
      name,
      description: plan.description,
      ...auditViaFields(actor),
      ...apiTraceFields(trace),
    },
    ip: actor.ip,
  });
  return { ok: true, data: { key: plan.key, name } };
}

/** 创建自定义角色（后台入口）：先校验 → 同事务写入并审计 → 提交后失效规则快照。 */
export async function createCustomRole(
  actor: AdminActor,
  key: string,
  name: string,
  description: string,
): Promise<void> {
  const planned = planRoleCreate({ key, name, description });
  if (!planned.ok) throw new AdminError(planned.message ?? planned.code);
  await getWebDb().transaction(async (tx) => {
    const applied = await applyRoleCreate(tx, actor, planned.plan);
    if (!applied.ok) throw new AdminError(applied.message ?? applied.code);
  });
  invalidateAuthzSnapshot();
}

/** 删除自定义角色的拒绝码（对应既有 AdminError 文案分类）。 */
export type RoleDeleteCode = "not_found" | "builtin_role" | "team_role" | "last_admin";
export type RoleDeleteDenial = ModerationWriteDenial<RoleDeleteCode>;

/** 删除自定义角色的事务外校验计划（后台与 REST 共享）。 */
type RoleDeletePlan = { key: string };

/** 根据实际角色行检查内置角色与固定团队角色。 */
function checkRoleDelete(role: Pick<LockedRole, "key" | "kind">): RoleDeleteDenial | null {
  if (role.kind === "builtin" || BUILTIN_ROLES.has(role.key)) {
    return { ok: false, code: "builtin_role", message: "内置角色不可删除" };
  }
  if (isTeamMembershipRole(role.key)) {
    return { ok: false, code: "team_role", message: "固定团队角色不能删除" };
  }
  return null;
}

/** 后台保留角色预检；REST 删除回放必须能越过已不存在的目标。 */
export async function planRoleDelete(
  key: string,
  precheck = true,
): Promise<{ ok: true; plan: RoleDeletePlan } | RoleDeleteDenial> {
  if (precheck) {
    const role = await findRole(key);
    if (!role) return roleNotFound(key);
    const denial = checkRoleDelete(role);
    if (denial) return denial;
  }
  return { ok: true, plan: { key } };
}

/** 执行段（后台与 REST 共享）：连带清理授权与绑定 + last-admin 裁决 + 撤权联动 + 审计。 */
export async function applyRoleDelete(
  tx: DbTx,
  actor: AdminActor,
  plan: RoleDeletePlan,
  trace?: ModerationApiTrace,
  locked?: LockedRole,
): Promise<
  { ok: true; data: { key: string; grants: number; holders: number } } | RoleDeleteDenial
> {
  const { key } = plan;
  const role = locked ?? (await lockExistingRole(tx, key));
  if (!role) return roleNotFound(key);
  const guard = checkRoleDelete(role);
  if (guard) return guard;
  const grants = await tx.select().from(roleGrants).where(eq(roleGrants.roleKey, key));
  const holders = await tx.select().from(userRoles).where(eq(userRoles.roleKey, key));
  // 删除会清理排序规则命中的历史键，资格则按每个实际授权键分别检查。
  const adminGrantKeys = new Set(
    grants
      .filter((grant) => grant.scopeId === 0 && ADMIN_LOCKED.has(grant.permissionKey))
      .map((grant) => grant.roleKey),
  );
  let affectsPermanentAdmin = false;
  for (const roleKey of adminGrantKeys) {
    if (
      holders.some((h) => h.roleKey === roleKey && h.scopeId === 0 && h.expiresAt === null) &&
      (await hasPermanentSiteAdmin(tx, { throughRoleKey: roleKey }))
    ) {
      affectsPermanentAdmin = true;
      break;
    }
  }
  await tx.delete(roleGrants).where(eq(roleGrants.roleKey, key));
  await tx.delete(userRoles).where(eq(userRoles.roleKey, key));
  await tx.delete(roles).where(eq(roles.key, key));
  if (affectsPermanentAdmin) {
    const denial = await adjudicatePermanentSiteAdminRemains(tx);
    if (denial) return denial;
  }
  if (adminGrantKeys.size > 0) {
    // M20 撤权联动：连带撤销管理授权时，逐人复核实际角色持有人的令牌资格。
    const userIds = new Set(
      holders.filter((h) => adminGrantKeys.has(h.roleKey)).map((h) => h.userId),
    );
    for (const uid of userIds) {
      await revokeAdminApiTokensIfNotSiteAdmin(tx, uid, {
        actorId: actor.userId,
        via: actor.via ?? "admin",
        ...(trace ?? {}),
      });
    }
  }
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "role.delete",
    targetType: "role",
    targetId: key,
    before: { grants: grants.length, holders: holders.length },
    ...(actor.via || trace
      ? { after: { ...auditViaFields(actor), ...apiTraceFields(trace) } }
      : {}),
    ip: actor.ip,
  });
  return { ok: true, data: { key, grants: grants.length, holders: holders.length } };
}

/** 删除自定义角色（后台入口）：先校验 → 同事务写入并审计 → 提交后失效规则快照。 */
export async function deleteCustomRole(actor: AdminActor, key: string): Promise<void> {
  const planned = await planRoleDelete(key);
  if (!planned.ok) throw new AdminError(planned.message ?? planned.code);
  await getWebDb().transaction(async (tx) => {
    const applied = await applyRoleDelete(tx, actor, planned.plan);
    if (!applied.ok) throw new AdminError(applied.message ?? applied.code);
  }, SITE_ADMIN_TX_OPTIONS);
  invalidateAuthzSnapshot();
}
