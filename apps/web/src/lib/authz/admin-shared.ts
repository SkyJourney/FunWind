import "server-only";

import { eq } from "drizzle-orm";
import { forums, getWebDb, roles } from "@funwind/db";
import type { DbTx } from "@/lib/audit";
import type { ModerationApiTrace, ModerationWriteDenial } from "@/lib/moderation/contents";
import {
  hasPermanentSiteAdmin,
  lockSiteAdminInvariant,
  SiteAdminInvariantError,
} from "./site-admin-invariant";
import { getAuthzSnapshot } from "./snapshot";

export interface AdminActor {
  userId: number;
  ip: string | null;
  /** 操作来源：REST 管理端点传 "api"（审计 after 附加 via 与 trace）；后台缺省不附加，审计形态不变 */
  via?: string;
}

/** 内置角色不能用自定义角色入口创建或删除。 */
export const BUILTIN_ROLES = new Set(["guest", "member", "admin"]);

/** 新写入的角色键遵守角色词汇格式及列长限制。 */
export function isCanonicalRoleKey(key: string): boolean {
  return key.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key);
}

/** REST 审计的 API 追踪字段（仅 REST 传入 trace 时附加；后台不带 trace，审计形态不变）。 */
export const apiTraceFields = (trace?: ModerationApiTrace) =>
  trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {};

/** 审计 after 的来源标记：后台 actor 无 via → 不附加（审计 after 形态逐字节不变）。 */
export const auditViaFields = (actor: AdminActor) => (actor.via ? { via: actor.via } : {});

/** 后台管理权限点：公开身份角色不得持有。 */
export const isBackstagePermission = (permissionKey: string) =>
  permissionKey === "site.admin" ||
  permissionKey === "user.viewIp" ||
  permissionKey.startsWith("admin.");

type RoleRow = Pick<typeof roles.$inferSelect, "key" | "kind" | "isPublic">;

/** 事务外查询角色，供后台输入预检。 */
export async function findRole(key: string): Promise<RoleRow | null> {
  const rows = await getWebDb()
    .select({ key: roles.key, kind: roles.kind, isPublic: roles.isPublic })
    .from(roles)
    .where(eq(roles.key, key))
    .limit(1);
  return rows[0] ?? null;
}

export type LockedRole = RoleRow;

/** 先锁管理员不变量，再对目标角色做当前读并持有排他锁。 */
export async function lockExistingRole(tx: DbTx, key: string): Promise<LockedRole | null> {
  await lockSiteAdminInvariant(tx);
  const [role] = await tx
    .select({ key: roles.key, kind: roles.kind, isPublic: roles.isPublic })
    .from(roles)
    .where(eq(roles.key, key))
    .limit(1)
    .for("update");
  return role ?? null;
}

/** 统一后台错误文案与 REST 拒绝码。 */
export function roleNotFound(key: string) {
  return { ok: false, code: "not_found", message: `角色不存在: ${key}` } as const;
}

/** 检查作用域。事务内使用同一连接对目标版块做当前读。 */
export async function checkScope(
  scopeId: number,
  tx?: DbTx,
): Promise<{ code: "bad_scope" | "scope_not_found"; message: string } | null> {
  if (!Number.isInteger(scopeId) || scopeId < 0) {
    return { code: "bad_scope", message: "作用域无效" };
  }
  if (scopeId === 0) return null;
  const exists = tx
    ? (await tx.select({ id: forums.id }).from(forums).where(eq(forums.id, scopeId)).for("share"))
        .length > 0
    : (await getAuthzSnapshot()).tree.has(scopeId);
  return exists ? null : { code: "scope_not_found", message: `版块不存在: ${scopeId}` };
}

/**
 * 在试撤权后检查是否仍有永久站点管理员。仅在写入可能影响已有永久资格时调用。
 * 调用方收到拒绝必须抛出异常，让工作事务中此前的写入一并回滚。
 */
export async function adjudicatePermanentSiteAdminRemains(
  tx: DbTx,
): Promise<ModerationWriteDenial<"last_admin"> | null> {
  return (await hasPermanentSiteAdmin(tx))
    ? null
    : { ok: false, code: "last_admin", message: new SiteAdminInvariantError().message };
}
