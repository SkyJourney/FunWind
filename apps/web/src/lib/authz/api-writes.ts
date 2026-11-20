import "server-only";

import type { ModerationApiTrace, PreparedModerationWrite } from "@/lib/moderation/contents";
import {
  applyRoleCreate,
  applyRoleDelete,
  applyRoleGrant,
  applyRoleRevoke,
  lockRoleGrant,
  planRoleCreate,
  planRoleDelete,
  planRoleGrant,
  planRoleRevoke,
  type RoleCreateCode,
  type RoleCreateDenial,
  type RoleDeleteCode,
  type RoleDeleteDenial,
  type RoleGrantCode,
  type RoleGrantDenial,
  type RoleRevokeCode,
  type RoleRevokeDenial,
} from "./admin-role-writes";
import { lockExistingRole, roleNotFound, type AdminActor } from "./admin-shared";
import {
  applyUserAssign,
  applyUserRevoke,
  dispatchRoleChanges,
  lockUserAssign,
  lockUserRevoke,
  planUserRoleAssign,
  planUserRoleRevoke,
  type UserRoleAssignCode,
  type UserRoleAssignDenial,
  type UserRoleRevokeCode,
  type UserRoleRevokeDenial,
} from "./admin-user-role-writes";
import { invalidateAuthzSnapshot } from "./snapshot";

/**
 * 幂等写管线先识别回放，再锁定目标并执行变更。
 * 执行拒绝由调用方在事务内转为异常，撤权改动和幂等占位一起回滚。
 * 快照失效与事件派发统一在提交后执行。
 */

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const ROLES_DENIAL_HTTP = {
  // 不存在类
  not_found: "not_found",
  scope_not_found: "not_found",
  user_not_found: "not_found",
  // 护栏 / last-admin / 防自锁 / 重名 / 状态类
  builtin_key: "state_conflict",
  already_exists: "state_conflict",
  builtin_role: "state_conflict",
  team_role: "state_conflict",
  public_admin: "state_conflict",
  implicit_guard: "state_conflict",
  implicit_role: "state_conflict",
  admin_locked: "state_conflict",
  last_admin: "state_conflict",
  user_closing: "state_conflict",
  // 入参类
  bad_key: "bad_request",
  unknown_permission: "bad_request",
  bad_scope: "bad_request",
  bad_expires_at: "bad_request",
  reason_required: "bad_request",
  reason_too_long: "bad_request",
} as const satisfies Record<
  | RoleCreateCode
  | RoleDeleteCode
  | RoleGrantCode
  | RoleRevokeCode
  | UserRoleAssignCode
  | UserRoleRevokeCode,
  "bad_request" | "not_found" | "state_conflict"
>;

/** REST 各写变体的准备产物类型（data 为写响应载荷，denial 复用域拒绝码）。 */
export type PreparedApiRoleCreate = PreparedModerationWrite<
  { key: string; name: string },
  RoleCreateCode
>;
export type PreparedApiRoleDelete = PreparedModerationWrite<
  { key: string; grants: number; holders: number },
  RoleDeleteCode
>;
export type PreparedApiRoleGrant = PreparedModerationWrite<
  { roleKey: string; permissionKey: string; scopeId: number; changed: boolean },
  RoleGrantCode
>;
export type PreparedApiRoleRevoke = PreparedModerationWrite<
  { roleKey: string; permissionKey: string; scopeId: number; changed: boolean },
  RoleRevokeCode
>;
export type PreparedApiUserRoleAssign = PreparedModerationWrite<
  { userId: number; roleKey: string; scopeId: number },
  UserRoleAssignCode
>;
export type PreparedApiUserRoleRevoke = PreparedModerationWrite<
  { userId: number; roleKey: string; scopeId: number; changed: boolean },
  UserRoleRevokeCode
>;

/** REST 创建自定义角色：入参校验在 prepare（事务外）；重名裁决与写入在 execute。 */
export async function prepareApiRoleCreate(
  actor: AdminActor,
  input: { key: string; name: string; description: string },
  trace?: ModerationApiTrace,
): Promise<PreparedApiRoleCreate | RoleCreateDenial> {
  const planned = planRoleCreate(input);
  if (!planned.ok) return planned;
  return {
    ok: true,
    async lock(tx) {
      // 创建无行锁目标；重名裁决与写入归入 execute（roles.key 唯一键兜底并发，同一事务）
      return {
        ok: true,
        async execute() {
          const applied = await applyRoleCreate(tx, actor, planned.plan, trace);
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: applied.data,
            async afterCommit() {
              invalidateAuthzSnapshot();
            },
          };
        },
      };
    },
  };
}

/** 仅新删除请求复验并锁定角色，已完成的回放可直接返回首次结果。 */
export async function prepareApiRoleDelete(
  actor: AdminActor,
  key: string,
  trace?: ModerationApiTrace,
): Promise<PreparedApiRoleDelete | RoleDeleteDenial> {
  const planned = await planRoleDelete(key, false);
  if (!planned.ok) return planned;
  return {
    ok: true,
    async lock(tx) {
      const role = await lockExistingRole(tx, key);
      if (!role) return roleNotFound(key);
      return {
        ok: true,
        async execute() {
          const applied = await applyRoleDelete(tx, actor, planned.plan, trace, role);
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: applied.data,
            async afterCommit() {
              invalidateAuthzSnapshot();
            },
          };
        },
      };
    },
  };
}

/** 授权时用已锁角色的实际公开状态复验管理权限护栏。 */
export async function prepareApiRoleGrant(
  actor: AdminActor,
  roleKey: string,
  permissionKey: string,
  scopeId: number,
  trace?: ModerationApiTrace,
): Promise<PreparedApiRoleGrant | RoleGrantDenial> {
  const planned = await planRoleGrant({ roleKey, permissionKey, scopeId }, false);
  if (!planned.ok) return planned;
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockRoleGrant(tx, planned.plan);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          const applied = await applyRoleGrant(tx, actor, planned.plan, locked.role, trace);
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: applied.data,
            async afterCommit() {
              invalidateAuthzSnapshot();
            },
          };
        },
      };
    },
  };
}

/** 锁定角色后撤销指定授权，并复验最后一位管理员护栏。 */
export async function prepareApiRoleRevoke(
  actor: AdminActor,
  roleKey: string,
  permissionKey: string,
  scopeId: number,
  trace?: ModerationApiTrace,
): Promise<PreparedApiRoleRevoke | RoleRevokeDenial> {
  const planned = await planRoleRevoke({ roleKey, permissionKey, scopeId }, false);
  if (!planned.ok) return planned;
  return {
    ok: true,
    async lock(tx) {
      if (!(await lockExistingRole(tx, roleKey))) return roleNotFound(roleKey);
      return {
        ok: true,
        async execute() {
          const applied = await applyRoleRevoke(tx, actor, planned.plan, trace);
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: applied.data,
            async afterCommit() {
              invalidateAuthzSnapshot();
            },
          };
        },
      };
    },
  };
}

/** 绑定前锁定角色和目标用户，复验后到期时间、写入和事件入队共享同一事务。 */
export async function prepareApiUserRoleAssign(
  actor: AdminActor,
  userId: number,
  roleKey: string,
  scopeId: number,
  expiresAt: string | null,
  reason: string,
  trace?: ModerationApiTrace,
): Promise<PreparedApiUserRoleAssign | UserRoleAssignDenial> {
  const planned = await planUserRoleAssign({ userId, roleKey, scopeId, expiresAt, reason }, false);
  if (!planned.ok) return planned;
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockUserAssign(tx, planned.plan);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          const applied = await applyUserAssign(tx, actor, locked.plan, trace);
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: applied.data,
            async afterCommit() {
              invalidateAuthzSnapshot();
              await dispatchRoleChanges([applied.event], {});
            },
          };
        },
      };
    },
  };
}

/** 解绑在锁内裁决，当事人失去管理员权限时在同一事务吊销令牌。 */
export async function prepareApiUserRoleRevoke(
  actor: AdminActor,
  userId: number,
  roleKey: string,
  scopeId: number,
  reason: string,
  trace?: ModerationApiTrace,
): Promise<PreparedApiUserRoleRevoke | UserRoleRevokeDenial> {
  const planned = planUserRoleRevoke({ userId, roleKey, scopeId, reason });
  if (!planned.ok) return planned;
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockUserRevoke(tx, planned.plan);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          const applied = await applyUserRevoke(tx, actor, planned.plan, trace);
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: applied.data,
            async afterCommit() {
              invalidateAuthzSnapshot();
              if (applied.event) await dispatchRoleChanges([applied.event], {});
            },
          };
        },
      };
    },
  };
}
