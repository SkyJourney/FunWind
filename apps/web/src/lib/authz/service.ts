import { and, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { accountDeletionRequests, getWebDb, userRoles, users } from "@funwind/db";
import {
  contentVisibleTo,
  evaluate,
  moderatedForumIds,
  readableForumIds,
  type ContentState,
  type EvalContext,
} from "./evaluator";
import { getAuthzSnapshot } from "./snapshot";
import { getCurrentSubject } from "./subject";
import type { Decision, Subject } from "./types";

/**
 * 权限服务：评估器 + 规则快照 + 主体 的组合入口。
 * 所有检查都**显式传入 Subject**（由 loadSubject(userId) 或 getCurrentSubject() 得到），
 * 取代 M5 里“忽略传入 userId、偷偷读当前请求用户”的 checkPermission(userId, …)。
 */

export class ForbiddenError extends Error {
  constructor(
    public readonly permissionKey: string,
    public readonly reason: string,
  ) {
    super(`权限不足: ${permissionKey}（${reason}）`);
    this.name = "ForbiddenError";
  }
}

export async function checkPermission(
  subject: Subject,
  permissionKey: string,
  ctx: EvalContext = {},
): Promise<Decision> {
  return evaluate(subject, permissionKey, ctx, await getAuthzSnapshot());
}

/** 拒绝时抛 ForbiddenError（Server Action 入口用；页面层应捕获并按 404 处理） */
export async function requirePermission(
  subject: Subject,
  permissionKey: string,
  ctx: EvalContext = {},
): Promise<void> {
  const d = await checkPermission(subject, permissionKey, ctx);
  if (!d.allowed) throw new ForbiddenError(permissionKey, d.reason);
}

/** 当前请求用户的便捷封装 */
export async function can(permissionKey: string, ctx: EvalContext = {}): Promise<boolean> {
  return (await checkPermission(await getCurrentSubject(), permissionKey, ctx)).allowed;
}

export async function canSeeContent(
  subject: Subject,
  content: { state: ContentState; authorId: number; forumId: number },
): Promise<boolean> {
  return contentVisibleTo(subject, content, await getAuthzSnapshot());
}

/** 主体可读 / 可管的版块 id 集合：查询层在取数前据此过滤 */
export async function getReadableForumIds(subject: Subject): Promise<number[]> {
  return readableForumIds(subject, await getAuthzSnapshot());
}

export async function getModeratedForumIds(subject: Subject): Promise<number[]> {
  return moderatedForumIds(subject, await getAuthzSnapshot());
}

/**
 * 版主 = 在该版块作用域链上持有 forum.moderate 授权的角色的持有人（版主由授权派生，不单独指派）。
 * viaParent=true 表示授权来自祖先版块或全局，而非本版块自身。
 */
export async function getForumModerators(
  forumId: number,
): Promise<{ userId: number; username: string; viaParent: boolean }[]> {
  const snap = await getAuthzSnapshot();
  const chain = snap.tree.chain(forumId);
  if (chain.length === 0) return [];

  // 授予 forum.moderate 的 (角色, 授权作用域)；admin 短路放行但不属于“版主”，不列出
  const roleScope = new Map<string, number[]>();
  for (const g of snap.grants) {
    // admin 的全局 forum.moderate 是基线授权，不代表“该版块的版主”，否则每个版块都会列出全体管理员
    if (g.permissionKey !== "forum.moderate" || g.roleKey === "admin") continue;
    if (g.scopeId !== 0 && !chain.includes(g.scopeId)) continue;
    roleScope.set(g.roleKey, [...(roleScope.get(g.roleKey) ?? []), g.scopeId]);
  }
  if (roleScope.size === 0) return [];

  const holders = await getWebDb()
    .select({
      userId: userRoles.userId,
      roleKey: userRoles.roleKey,
      bindScope: userRoles.scopeId,
      username: users.username,
    })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(
        inArray(userRoles.roleKey, [...roleScope.keys()]),
        eq(users.state, "active"),
        notExists(
          getWebDb()
            .select({ id: accountDeletionRequests.id })
            .from(accountDeletionRequests)
            .where(
              and(
                eq(accountDeletionRequests.userId, users.id),
                eq(accountDeletionRequests.status, "completed"),
              ),
            ),
        ),
        or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > NOW()`),
      ),
    );

  const out = new Map<number, { userId: number; username: string; viaParent: boolean }>();
  for (const h of holders) {
    // 角色绑定本身的作用域也必须覆盖该版块
    if (h.bindScope !== 0 && !chain.includes(h.bindScope)) continue;
    const direct = (roleScope.get(h.roleKey) ?? []).includes(forumId);
    const prev = out.get(h.userId);
    if (!prev || (prev.viaParent && direct)) {
      out.set(h.userId, { userId: h.userId, username: h.username, viaParent: !direct });
    }
  }
  return [...out.values()].sort((a, b) => a.userId - b.userId);
}
