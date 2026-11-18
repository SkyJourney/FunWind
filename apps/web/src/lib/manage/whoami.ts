import "server-only";

import { eq } from "drizzle-orm";
import { adminApiTokens, getWebDb, PERMISSION_DEFINITIONS, users } from "@funwind/db";
import { checkPermission } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";
import {
  getManageEndpoint,
  type ManageEndpointDefinition,
  type ManageEndpointId,
} from "@/lib/manage/permissions";
import type { UsableAdminApiToken } from "@/lib/manage/tokens";

/**
 * whoami 数据组装（M20 v1）：token 元信息 + 持有人 + 有效权限点全清单。
 * MCP 客户端（M21）握手时据此决定可用工具集；不写审计（高频、无业务动作）。
 */

export type WhoamiData = {
  token: {
    name: string;
    suffix: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt: string | null;
  };
  user: { id: number; username: string };
  /** 评估器实时判定通过的全部权限点 key（撤销授权后下一请求即收缩） */
  permissions: string[];
  /** 仅在显式请求时返回；生效列表不承诺对任何具体资源有权限。 */
  tokenPermissions?: { granted: WhoamiEndpointGrant[]; effective: WhoamiEndpointGrant[] };
};

type WhoamiEndpointGrant = {
  id: ManageEndpointId;
  method: ManageEndpointDefinition["method"];
  path: ManageEndpointDefinition["path"];
  scope: `${ManageEndpointDefinition["domain"]}:${ManageEndpointDefinition["access"]}`;
};

export async function loadWhoami(
  token: UsableAdminApiToken,
  subject: Subject,
  includeTokenPermissions = false,
): Promise<WhoamiData> {
  const db = getWebDb();
  const [[row], [user]] = await Promise.all([
    db
      .select({
        name: adminApiTokens.name,
        suffix: adminApiTokens.suffix,
        createdAt: adminApiTokens.createdAt,
        expiresAt: adminApiTokens.expiresAt,
        lastUsedAt: adminApiTokens.lastUsedAt,
      })
      .from(adminApiTokens)
      .where(eq(adminApiTokens.id, token.id))
      .limit(1),
    db.select({ username: users.username }).from(users).where(eq(users.id, token.userId)).limit(1),
  ]);

  const permissions: string[] = [];
  for (const def of PERMISSION_DEFINITIONS) {
    if ((await checkPermission(subject, def.key)).allowed) permissions.push(def.key);
  }

  return {
    token: {
      name: row?.name ?? "",
      suffix: row?.suffix ?? "",
      createdAt: row?.createdAt ?? "",
      expiresAt: row?.expiresAt ?? "",
      lastUsedAt: row?.lastUsedAt ?? null,
    },
    user: { id: token.userId, username: user?.username ?? "" },
    permissions,
    ...(includeTokenPermissions
      ? { tokenPermissions: describeTokenPermissions(token, permissions) }
      : {}),
  };
}

/** 授权快照不可变，生效清单只按当前主体的全局业务权限裁剪。 */
function describeTokenPermissions(
  token: UsableAdminApiToken,
  permissions: readonly string[],
): NonNullable<WhoamiData["tokenPermissions"]> {
  const hasPermission = new Set(permissions);
  const granted: WhoamiEndpointGrant[] = [];
  const effective: WhoamiEndpointGrant[] = [];
  for (const id of token.endpointGrants) {
    const { method, path, domain, access, permission } = getManageEndpoint(id);
    const entry: WhoamiEndpointGrant = { id, method, path, scope: `${domain}:${access}` };
    granted.push(entry);
    if (!permission || hasPermission.has(permission)) effective.push(entry);
  }
  return { granted, effective };
}
