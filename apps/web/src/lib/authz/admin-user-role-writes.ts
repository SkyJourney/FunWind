import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { getWebDb, userRoles } from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import { isFutureBeijingDateTime } from "@/lib/datetime";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
  type OutboxEmitter,
} from "@/lib/events/outbox";
import { lockActiveUserInTx } from "@/lib/identity";
import { revokeAdminApiTokensIfNotSiteAdmin } from "@/lib/manage/tokens";
import type { ModerationApiTrace, ModerationWriteDenial } from "@/lib/moderation/contents";
import {
  ROLE_NOTIFICATION_DELIVERY_POLICY,
  type EventName,
  type EventPayloads,
} from "@/modules/kernel/types";
import { AdminError } from "./admin-error";
import {
  adjudicatePermanentSiteAdminRemains,
  apiTraceFields,
  auditViaFields,
  checkScope,
  findRole,
  isCanonicalRoleKey,
  lockExistingRole,
  roleNotFound,
  type AdminActor,
} from "./admin-shared";
import {
  hasPermanentSiteAdmin,
  roleHasGlobalSiteAdminGrant,
  SITE_ADMIN_TX_OPTIONS,
} from "./site-admin-invariant";
import { isTeamMembershipRole } from "./team-role-mapping";

export interface AdminDeps {
  /** 覆盖事件派发（单测注入；缺省走内核总线） */
  emitter?: (name: "role.changed", payload: EventPayloads["role.changed"]) => Promise<unknown>;
}

/** 提交后派发事务内登记的角色事件；失败留在 outbox 等补派 */
export async function dispatchRoleChanges(
  events: readonly EnqueuedEvent[],
  deps: AdminDeps,
): Promise<void> {
  const customEmitter = deps.emitter;
  const emitter: OutboxEmitter | undefined = customEmitter
    ? async <K extends EventName>(name: K, payload: EventPayloads[K]) => {
        if (name === "role.changed") {
          return customEmitter("role.changed", payload as EventPayloads["role.changed"]);
        }
        return undefined;
      }
    : undefined;
  await dispatchOutboxRows(events, emitter ? { emitter } : {});
  await sweepPending();
}

/** 绑定用户角色的拒绝码（对应既有 AdminError 文案分类）。 */
export type UserRoleAssignCode =
  | "implicit_role"
  | "bad_expires_at"
  | "team_role"
  | "not_found"
  | "bad_scope"
  | "scope_not_found"
  | "reason_required"
  | "reason_too_long"
  | "user_not_found"
  | "user_closing"
  | "last_admin";
export type UserRoleAssignDenial = ModerationWriteDenial<UserRoleAssignCode>;

/** 绑定用户角色的事务外校验计划（后台与 REST 共享；reason 已裁剪）。 */
type UserRoleAssignPlan = {
  userId: number;
  roleKey: string;
  scopeId: number;
  expiresAt: string | null;
  reason: string;
};

/** 返回禁止直接绑定的隐式角色错误。 */
function checkImplicitRole(roleKey: string): UserRoleAssignDenial | null {
  return roleKey === "guest" || roleKey === "member"
    ? { ok: false, code: "implicit_role", message: `${roleKey} 是隐式角色，不能绑定到用户` }
    : null;
}

/** 有效期必须晚于本次写入时刻。 */
function checkAssignmentExpiry(expiresAt: string | null): UserRoleAssignDenial | null {
  return expiresAt !== null && !isFutureBeijingDateTime(expiresAt)
    ? { ok: false, code: "bad_expires_at", message: "到期时间必须是有效的未来北京时间" }
    : null;
}

/** 团队成员身份的变更只能通过团队服务。 */
function teamAssignmentDenial(roleKey: string): UserRoleAssignDenial | null {
  return isTeamMembershipRole(roleKey)
    ? { ok: false, code: "team_role", message: "团队角色必须通过团队成员服务授予" }
    : null;
}

/** 校验绑定意图。后台保留预检顺序，REST 在幂等事务内检查可变状态。 */
export async function planUserRoleAssign(
  input: UserRoleAssignPlan,
  precheck = true,
): Promise<{ ok: true; plan: UserRoleAssignPlan } | UserRoleAssignDenial> {
  const denial =
    checkImplicitRole(input.roleKey) ??
    (precheck ? checkAssignmentExpiry(input.expiresAt) : null) ??
    teamAssignmentDenial(input.roleKey);
  if (denial) return denial;
  if (precheck) {
    const role = await findRole(input.roleKey);
    if (!role) return roleNotFound(input.roleKey);
    const roleDenial = checkImplicitRole(role.key) ?? teamAssignmentDenial(role.key);
    if (roleDenial) return roleDenial;
    const scopeDenial = await checkScope(input.scopeId);
    if (scopeDenial) return { ok: false, ...scopeDenial };
  }
  const why = input.reason.trim();
  if (!why) return { ok: false, code: "reason_required", message: "必须填写授予理由" };
  if (why.length > 255) {
    return { ok: false, code: "reason_too_long", message: "授予理由不能超过 255 个字符" };
  }
  return {
    ok: true,
    plan: {
      userId: input.userId,
      roleKey: input.roleKey,
      scopeId: input.scopeId,
      expiresAt: input.expiresAt,
      reason: why,
    },
  };
}

/** 按管理员不变量、角色、目标用户的顺序取锁，并复核用户仍可绑定。 */
export async function lockUserAssign(
  tx: DbTx,
  plan: UserRoleAssignPlan,
): Promise<{ ok: true; plan: UserRoleAssignPlan } | UserRoleAssignDenial> {
  const role = await lockExistingRole(tx, plan.roleKey);
  if (!role || !isCanonicalRoleKey(role.key)) return roleNotFound(plan.roleKey);
  const denial = checkImplicitRole(role.key) ?? teamAssignmentDenial(role.key);
  if (denial) return denial;
  const target = await lockActiveUserInTx(tx, plan.userId);
  if (!target.ok) {
    return target.code === "closing"
      ? { ok: false, code: "user_closing", message: `用户正在注销或已注销: ${plan.userId}` }
      : { ok: false, code: "user_not_found", message: `用户不存在或已注销: ${plan.userId}` };
  }
  return { ok: true, plan: { ...plan, roleKey: role.key } };
}

/** 执行段（后台与 REST 共享）：绑定写入（重复绑定为到期时间更新）+ 审计 + role.changed 入队。 */
export async function applyUserAssign(
  tx: DbTx,
  actor: AdminActor,
  plan: UserRoleAssignPlan,
  trace?: ModerationApiTrace,
): Promise<
  | { ok: true; data: { userId: number; roleKey: string; scopeId: number }; event: EnqueuedEvent }
  | UserRoleAssignDenial
> {
  const expiryDenial = checkAssignmentExpiry(plan.expiresAt);
  if (expiryDenial) return expiryDenial;
  const scopeDenial = await checkScope(plan.scopeId, tx);
  if (scopeDenial) return { ok: false, ...scopeDenial };
  // 唯一键可能命中历史别名；只有实际被改为限时的永久全站绑定才可能削弱保底。
  const [existing] =
    plan.scopeId === 0 && plan.expiresAt !== null
      ? await tx
          .select({ roleKey: userRoles.roleKey, expiresAt: userRoles.expiresAt })
          .from(userRoles)
          .where(
            and(
              eq(userRoles.userId, plan.userId),
              eq(userRoles.roleKey, plan.roleKey),
              eq(userRoles.scopeId, 0),
            ),
          )
      : [];
  const affectsPermanentAdmin =
    existing?.expiresAt === null &&
    (await hasPermanentSiteAdmin(tx, { userId: plan.userId, throughRoleKey: existing.roleKey }));
  await tx
    .insert(userRoles)
    .values({
      userId: plan.userId,
      roleKey: plan.roleKey,
      scopeId: plan.scopeId,
      expiresAt: plan.expiresAt,
      grantedBy: actor.userId,
      grantedAt: sql`NOW()`,
    })
    .onDuplicateKeyUpdate({ set: { expiresAt: plan.expiresAt } });
  if (affectsPermanentAdmin) {
    const denial = await adjudicatePermanentSiteAdminRemains(tx);
    if (denial) return denial;
  }
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "user_role.assign",
    targetType: "user",
    targetId: plan.userId,
    after: {
      roleKey: plan.roleKey,
      scopeId: plan.scopeId,
      expiresAt: plan.expiresAt,
      reason: plan.reason,
      ...auditViaFields(actor),
      ...apiTraceFields(trace),
    },
    ip: actor.ip,
  });
  const event = await enqueueEventInTx(
    tx,
    "role.changed",
    {
      userId: plan.userId,
      roleKey: plan.roleKey,
      scopeId: plan.scopeId,
      action: "granted",
      operatorId: actor.userId,
      expiresAt: plan.expiresAt,
    },
    {
      actorId: actor.userId,
      source: "admin",
      deliveryPolicy: ROLE_NOTIFICATION_DELIVERY_POLICY,
    },
  );
  return {
    ok: true,
    data: { userId: plan.userId, roleKey: plan.roleKey, scopeId: plan.scopeId },
    event,
  };
}

/** 绑定用户角色（后台入口）：先校验 → 同事务写入并审计 + 事件入队 → 提交后派发。 */
export async function assignUserRole(
  actor: AdminActor,
  userId: number,
  roleKey: string,
  scopeId: number,
  expiresAt: string | null,
  reason: string,
  deps: AdminDeps = {},
): Promise<void> {
  const planned = await planUserRoleAssign({ userId, roleKey, scopeId, expiresAt, reason });
  if (!planned.ok) throw new AdminError(planned.message ?? planned.code);
  const enqueued: EnqueuedEvent[] = [];
  await getWebDb().transaction(async (tx) => {
    const locked = await lockUserAssign(tx, planned.plan);
    if (!locked.ok) throw new AdminError(locked.message ?? locked.code);
    const applied = await applyUserAssign(tx, actor, locked.plan);
    if (!applied.ok) throw new AdminError(applied.message ?? applied.code);
    enqueued.push(applied.event);
  }, SITE_ADMIN_TX_OPTIONS);
  await dispatchRoleChanges(enqueued, deps);
}

/** 撤销用户角色绑定的拒绝码（对应既有 AdminError 文案分类）。 */
export type UserRoleRevokeCode = "team_role" | "reason_required" | "reason_too_long" | "last_admin";
export type UserRoleRevokeDenial = ModerationWriteDenial<UserRoleRevokeCode>;

/** 撤销用户角色绑定的事务外校验计划（后台与 REST 共享；reason 已裁剪）。 */
type UserRoleRevokePlan = { userId: number; roleKey: string; scopeId: number; reason: string };

/** 准备解绑请求时检查团队角色和撤销理由。 */
export function planUserRoleRevoke(input: {
  userId: number;
  roleKey: string;
  scopeId: number;
  reason: string;
}): { ok: true; plan: UserRoleRevokePlan } | UserRoleRevokeDenial {
  const denial = teamRevokeDenial(input.roleKey);
  if (denial) return denial;
  const why = input.reason.trim();
  if (!why) return { ok: false, code: "reason_required", message: "必须填写撤销理由" };
  if (why.length > 255) {
    return { ok: false, code: "reason_too_long", message: "撤销理由不能超过 255 个字符" };
  }
  return { ok: true, plan: { ...input, reason: why } };
}

/** 固定团队身份必须经团队成员服务解绑。 */
function teamRevokeDenial(roleKey: string): UserRoleRevokeDenial | null {
  return isTeamMembershipRole(roleKey)
    ? { ok: false, code: "team_role", message: "团队角色必须通过团队成员服务收回" }
    : null;
}

/** 锁定解绑关联的角色，仍允许清理不存在角色的历史绑定。 */
export async function lockUserRevoke(
  tx: DbTx,
  plan: UserRoleRevokePlan,
): Promise<{ ok: true } | UserRoleRevokeDenial> {
  const role = await lockExistingRole(tx, plan.roleKey);
  return teamRevokeDenial(role?.key ?? plan.roleKey) ?? { ok: true };
}

/** 执行段（后台与 REST 共享）：绑定行存在性裁决 + 删除 + 最后一位管理员护栏 + 撤权联动 + 审计 + 事件。 */
export async function applyUserRevoke(
  tx: DbTx,
  actor: AdminActor,
  plan: UserRoleRevokePlan,
  trace?: ModerationApiTrace,
): Promise<
  | {
      ok: true;
      data: { userId: number; roleKey: string; scopeId: number; changed: boolean };
      event?: EnqueuedEvent;
    }
  | UserRoleRevokeDenial
> {
  const rows = await tx
    .select({ id: userRoles.id, roleKey: userRoles.roleKey, expiresAt: userRoles.expiresAt })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, plan.userId),
        eq(userRoles.roleKey, plan.roleKey),
        eq(userRoles.scopeId, plan.scopeId),
      ),
    );
  if (rows.length === 0) {
    return {
      ok: true,
      data: { userId: plan.userId, roleKey: plan.roleKey, scopeId: plan.scopeId, changed: false },
    };
  }
  const { roleKey, expiresAt } = rows[0];
  const removesAdminGrant = plan.scopeId === 0 && (await roleHasGlobalSiteAdminGrant(tx, roleKey));
  const affectsPermanentAdmin =
    removesAdminGrant &&
    expiresAt === null &&
    (await hasPermanentSiteAdmin(tx, { userId: plan.userId, throughRoleKey: roleKey }));
  await tx.delete(userRoles).where(
    inArray(
      userRoles.id,
      rows.map((r) => r.id),
    ),
  );
  if (affectsPermanentAdmin) {
    const denial = await adjudicatePermanentSiteAdminRemains(tx);
    if (denial) return denial;
  }
  if (removesAdminGrant) {
    // 解绑后按当前有效资格复核令牌；限时绑定同样可能影响令牌资格。
    await revokeAdminApiTokensIfNotSiteAdmin(tx, plan.userId, {
      actorId: actor.userId,
      via: actor.via ?? "admin",
      ...(trace ?? {}),
    });
  }
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "user_role.revoke",
    targetType: "user",
    targetId: plan.userId,
    before: { roleKey: plan.roleKey, scopeId: plan.scopeId, expiresAt: rows[0]?.expiresAt ?? null },
    after: {
      reason: plan.reason,
      ...auditViaFields(actor),
      ...apiTraceFields(trace),
    },
    ip: actor.ip,
  });
  const event = await enqueueEventInTx(
    tx,
    "role.changed",
    {
      userId: plan.userId,
      roleKey: plan.roleKey,
      scopeId: plan.scopeId,
      action: "revoked",
      operatorId: actor.userId,
      expiresAt: rows[0]?.expiresAt ?? null,
    },
    {
      actorId: actor.userId,
      source: "admin",
      deliveryPolicy: ROLE_NOTIFICATION_DELIVERY_POLICY,
    },
  );
  return {
    ok: true,
    data: { userId: plan.userId, roleKey: plan.roleKey, scopeId: plan.scopeId, changed: true },
    event,
  };
}

/** 撤销用户角色绑定（后台入口）：先校验 → 同事务写入并审计 + 事件入队 → 提交后派发。 */
export async function revokeUserRole(
  actor: AdminActor,
  userId: number,
  roleKey: string,
  scopeId: number,
  reason: string,
  deps: AdminDeps = {},
): Promise<void> {
  const planned = planUserRoleRevoke({ userId, roleKey, scopeId, reason });
  if (!planned.ok) throw new AdminError(planned.message ?? planned.code);
  const enqueued: EnqueuedEvent[] = [];
  await getWebDb().transaction(async (tx) => {
    const locked = await lockUserRevoke(tx, planned.plan);
    if (!locked.ok) throw new AdminError(locked.message ?? locked.code);
    const applied = await applyUserRevoke(tx, actor, planned.plan);
    if (!applied.ok) throw new AdminError(applied.message ?? applied.code);
    if (applied.event) enqueued.push(applied.event);
  }, SITE_ADMIN_TX_OPTIONS);
  if (enqueued.length > 0) await dispatchRoleChanges(enqueued, deps);
}
