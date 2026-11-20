import "server-only";

import { z } from "zod";
import {
  ROLES_DENIAL_HTTP,
  prepareApiRoleCreate,
  prepareApiRoleDelete,
  prepareApiRoleGrant,
  prepareApiRoleRevoke,
  prepareApiUserRoleAssign,
  prepareApiUserRoleRevoke,
} from "@/lib/authz/admin";
import { checkPermission } from "@/lib/authz/service";
import { lockSiteAdminInvariant } from "@/lib/authz/site-admin-invariant";
import { loadFreshAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubjectFrom } from "@/lib/authz/subject";
import { SETTINGS_DENIAL_HTTP, prepareApiSettingsGroup } from "@/lib/settings/groups";
import { isValidBeijingDateTime } from "@/lib/datetime";
import {
  THEMES_DENIAL_HTTP,
  THEME_PACK_DESCRIPTION_MAX,
  THEME_PACK_NAME_MAX,
  prepareApiThemePackEnabled,
  prepareApiThemePackUpdate,
} from "@/lib/theme/api-writes";
import { commitWrite, type DenialHttpMap } from "@/lib/manage/content-writes";
import { ManageApiError } from "@/lib/manage/errors";
import { getManageEndpoint } from "@/lib/manage/permissions";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { lockScopedTokenEndpointGrants } from "@/lib/manage/tokens";

/**
 * 系统域适配层（M20.3 Step 5）：角色授权 / 站点设置 / 主题包的写端点接入。
 * 权限点：roles 域端点挂 admin.roles（用户角色绑定挂 admin.users）、settings/ops/themes 走 site.admin 基线。
 * ops 域的触发端点（202 受理）不走本适配层——受理非终态，不进幂等管线（见 ops trigger 路由）。
 */

export const SYSTEM_WRITES_DENIAL_HTTP: DenialHttpMap = {
  ...ROLES_DENIAL_HTTP,
  ...SETTINGS_DENIAL_HTTP,
  ...THEMES_DENIAL_HTTP,
};

/** API 操作者恒为令牌持有人；审计 trace 携带 requestId 与令牌尾号。 */
function apiAudit(ctx: ManageHandlerContext) {
  return {
    actor: { userId: ctx.token.userId, ip: ctx.ip, via: "api" as const },
    trace: { requestId: ctx.requestId, tokenSuffix: ctx.token.suffix },
  };
}

type WriteInput<T> = { targetId: number; idempotencyKey: string; input: T };

// ---------- 角色 ----------

type RoleWriteEndpoint =
  | "roles.create"
  | "roles.delete"
  | "roles.grant"
  | "roles.revoke"
  | "users.role-assign"
  | "users.role-revoke";

/** 仅角色六写在读幂等结果前重查身份；不使用入口的授权结果或缓存快照。 */
export function commitManageRoleWrite(
  ctx: ManageHandlerContext,
  endpoint: RoleWriteEndpoint,
  params: Parameters<typeof commitWrite>[2],
  operation: Parameters<typeof commitWrite>[3],
): Promise<unknown> {
  return commitWrite(ctx, endpoint, params, operation, SYSTEM_WRITES_DENIAL_HTTP, {
    async authorizeInTx(tx) {
      await lockSiteAdminInvariant(tx);
      const endpointGrants = await lockScopedTokenEndpointGrants(tx, ctx.token);
      if (!endpointGrants) throw new ManageApiError("unauthorized");

      // 注册模式沿用入口上下文；全局管理权限不依赖它。主体和授权均用当前事务重新加载。
      const subject = await loadSubjectFrom(tx, ctx.token.userId, ctx.subject.registerMode);
      if (subject.userId === null) throw new ManageApiError("unauthorized");
      const snapshot = await loadFreshAuthzSnapshot(tx);
      const permissions = new Set(["site.admin", "admin.roles"]);
      const { permission } = getManageEndpoint(endpoint);
      if (permission) permissions.add(permission);
      for (const required of permissions) {
        if (!(await checkPermission(subject, required, {}, snapshot)).allowed) {
          throw new ManageApiError("forbidden");
        }
      }
      if (!endpointGrants.includes(endpoint)) throw new ManageApiError("forbidden");
    },
  });
}

export const manageRoleCreateInput = z.strictObject({
  key: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(255).default(""),
});

export function createManageRole(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageRoleCreateInput>>,
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  return commitManageRoleWrite(
    ctx,
    "roles.create",
    params,
    prepareApiRoleCreate(actor, params.input, trace),
  );
}

/** 删除角色：roleKey 由路由从路径解析后注入（参与幂等指纹）。 */
export function deleteManageRole(
  ctx: ManageHandlerContext,
  params: { targetId: number; idempotencyKey: string; roleKey: string },
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  return commitManageRoleWrite(
    ctx,
    "roles.delete",
    {
      targetId: params.targetId,
      idempotencyKey: params.idempotencyKey,
      input: { roleKey: params.roleKey },
    },
    prepareApiRoleDelete(actor, params.roleKey, trace),
  );
}

export const manageRoleGrantInput = z.strictObject({
  scopeId: z.number().int().min(0).default(0),
});

export type RoleGrantParams = {
  targetId: number;
  idempotencyKey: string;
  input: { scopeId: number; roleKey: string; permissionKey: string };
};

export function grantManageRole(
  ctx: ManageHandlerContext,
  params: RoleGrantParams,
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  const { scopeId, roleKey, permissionKey } = params.input;
  return commitManageRoleWrite(
    ctx,
    "roles.grant",
    params,
    prepareApiRoleGrant(actor, roleKey, permissionKey, scopeId, trace),
  );
}

export function revokeManageRole(
  ctx: ManageHandlerContext,
  params: RoleGrantParams,
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  const { scopeId, roleKey, permissionKey } = params.input;
  return commitManageRoleWrite(
    ctx,
    "roles.revoke",
    params,
    prepareApiRoleRevoke(actor, roleKey, permissionKey, scopeId, trace),
  );
}

export const manageUserRoleInput = z.strictObject({
  scopeId: z.number().int().min(0).default(0),
  reason: z.string().trim().min(1).max(255),
  expiresAt: z.string().refine(isValidBeijingDateTime).nullable().default(null),
});

export type UserRoleParams = WriteInput<z.infer<typeof manageUserRoleInput>> & { roleKey: string };

export function assignManageUserRole(
  ctx: ManageHandlerContext,
  params: UserRoleParams,
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  return commitManageRoleWrite(
    ctx,
    "users.role-assign",
    {
      targetId: params.targetId,
      idempotencyKey: params.idempotencyKey,
      input: { ...params.input, roleKey: params.roleKey },
    },
    prepareApiUserRoleAssign(
      actor,
      params.targetId,
      params.roleKey,
      params.input.scopeId,
      params.input.expiresAt,
      params.input.reason,
      trace,
    ),
  );
}

export const manageUserRoleRevokeInput = manageUserRoleInput.omit({ expiresAt: true });

export function revokeManageUserRole(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageUserRoleRevokeInput>> & { roleKey: string },
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  return commitManageRoleWrite(
    ctx,
    "users.role-revoke",
    {
      targetId: params.targetId,
      idempotencyKey: params.idempotencyKey,
      input: { ...params.input, roleKey: params.roleKey },
    },
    prepareApiUserRoleRevoke(
      actor,
      params.targetId,
      params.roleKey,
      params.input.scopeId,
      params.input.reason,
      trace,
    ),
  );
}

// ---------- 站点设置 ----------

/** 更新设置分组：body 即组内结构化 JSON（白名单与 zod 在服务层 groups.ts 三段式变体）。 */
export function updateManageSettings(
  ctx: ManageHandlerContext,
  params: {
    targetId: number;
    idempotencyKey: string;
    group: string;
    input: unknown;
  },
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "settings.update",
    {
      targetId: params.targetId,
      idempotencyKey: params.idempotencyKey,
      input: { group: params.group, value: params.input },
    },
    prepareApiSettingsGroup(params.group, params.input, actor, trace),
    SYSTEM_WRITES_DENIAL_HTTP,
  );
}

// ---------- 主题包 ----------

export const manageThemeEditInput = z.strictObject({
  expectedRevision: z.number().int().min(1),
  name: z.string().trim().min(1).max(THEME_PACK_NAME_MAX).optional(),
  description: z.string().trim().max(THEME_PACK_DESCRIPTION_MAX).optional(),
});

/** 编辑主题包：packId 由路由从路径解析后注入（themes id 是字符串）。 */
export function editManageTheme(
  ctx: ManageHandlerContext,
  params: {
    targetId: number;
    idempotencyKey: string;
    packId: string;
    editInput: { name?: string; description?: string } & { expectedRevision: number };
  },
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  const { packId } = params;
  const { expectedRevision, ...rest } = params.editInput;
  return commitWrite(
    ctx,
    "themes.edit",
    {
      targetId: params.targetId,
      idempotencyKey: params.idempotencyKey,
      input: { ...rest, packId, expectedRevision },
    },
    prepareApiThemePackUpdate(actor, packId, expectedRevision, rest, trace),
    SYSTEM_WRITES_DENIAL_HTTP,
  );
}

export const manageThemeEnabledInput = z.strictObject({ enabled: z.boolean() });

/** 启停主题包：packId 由路由注入参与幂等指纹（prepare 只吃 enabled）。 */
export function toggleManageTheme(
  ctx: ManageHandlerContext,
  params: {
    targetId: number;
    idempotencyKey: string;
    input: { enabled: boolean; packId: string };
  },
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "themes.enabled",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: params.input },
    prepareApiThemePackEnabled(actor, params.input.packId, params.input.enabled, trace),
    SYSTEM_WRITES_DENIAL_HTTP,
  );
}
