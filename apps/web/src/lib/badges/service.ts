import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { cache } from "react";
import { accountDeletionRequests, badges, files, getWebDb, userBadges, users } from "@funwind/db";
import type { ConfigActor, DbTx } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";
import { AdminError } from "@/lib/authz/admin";
import { isDuplicateKey } from "@/lib/auth/register";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { publicUserId, publicUsername, userNotDeleted } from "@/lib/identity-expr";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";

/**
 * 荣誉徽章（M7）：badges / user_badges 展示 + 后台手动授予。纯装饰、零权限语义（docs/MODULES.md）。
 * 授予与 audit_log 同事务（POINTS_TX_OPTIONS 口径，M7-2）；`badge.awarded` 经 outbox 可靠派发；
 * 重复发放由 user_badges 联合主键 (user_id, badge_id) 兜底（并发第二笔整体回滚为 AdminError）。
 */

export interface UserBadgeView {
  badgeId: number;
  key: string;
  name: string;
  description: string;
  kind: "team" | "honor";
  /** 徽章图标存储键（files.storageKey）；旧站磁盘缺失的 4 枚为 null → 前端占位渲染 */
  iconKey: string | null;
  awardedAt: string;
}

/** 某用户的可见徽章（启用中的徽章、未过期）。请求级缓存：同一作者在一页楼层里只查一次 */
export const userBadgesOf = cache(async (userId: number): Promise<UserBadgeView[]> => {
  const db = getWebDb();
  const rows = await db
    .select({
      badgeId: badges.id,
      key: badges.key,
      name: badges.name,
      description: badges.description,
      kind: badges.kind,
      iconKey: files.storageKey,
      awardedAt: userBadges.awardedAt,
    })
    .from(userBadges)
    .innerJoin(badges, eq(badges.id, userBadges.badgeId))
    .innerJoin(users, eq(users.id, userBadges.userId))
    .leftJoin(files, eq(files.id, badges.iconFileId))
    .where(
      and(
        eq(userBadges.userId, userId),
        userNotDeleted(users.id, users.state),
        eq(badges.isActive, true),
        or(isNull(userBadges.expiresAt), sql`${userBadges.expiresAt} > NOW()`),
      ),
    )
    .orderBy(asc(badges.sortOrder), desc(userBadges.awardedAt));
  return rows;
});

/** 徽章字典（后台授予页下拉用，启用中的全部） */
export async function badgeDictionary() {
  return getWebDb()
    .select({
      id: badges.id,
      key: badges.key,
      name: badges.name,
      description: badges.description,
      kind: badges.kind,
      isActive: badges.isActive,
    })
    .from(badges)
    .where(and(eq(badges.isActive, true), eq(badges.kind, "honor")))
    .orderBy(asc(badges.sortOrder), asc(badges.id));
}

export interface GrantBadgeRequest {
  userId: number;
  badgeId: number;
}

/** 徽章写操作域拒绝码（M20.3 Step 4）：后台包装转 AdminError（文案由 denial.message 承载）。 */
export type BadgeDenialCode =
  "not_found" | "closed_account" | "not_active" | "team_badge" | "already_held" | "not_held";
type BadgeDenial = ModerationWriteDenial<BadgeDenialCode>;

/** 授予的行锁产物：徽章展示字段（审计 badgeName 与执行段裁决复用）。 */
type LockedGrantBadge = { id: number; name: string; kind: "team" | "honor"; isActive: boolean };

/** 锁段（后台与 REST 共享）：目标用户 active 行锁 + 徽章行锁；只做存在性，可变状态裁决在执行段。 */
async function lockBadgeGrantTarget(
  tx: DbTx,
  userId: number,
  badgeId: number,
): Promise<{ ok: true; badge: LockedGrantBadge } | BadgeDenial> {
  // 目标用户必须存在且未注销（user_badges 无外键；service 层自带此不变量，不依赖调用方）
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.state, "active")))
    .limit(1)
    .for("update");
  if (!user) return { ok: false, code: "not_found", message: "目标用户不存在或已注销" };
  const [badge] = await tx
    .select({ id: badges.id, name: badges.name, kind: badges.kind, isActive: badges.isActive })
    .from(badges)
    .where(eq(badges.id, badgeId))
    .limit(1)
    .for("update");
  if (!badge) return { ok: false, code: "not_found", message: "徽章不存在或已停用" };
  return { ok: true, badge };
}

/** 执行段（后台与 REST 共享）：注销申请/停用/团队/已持有裁决 + 写入 + 审计 + 事件（同事务）。 */
async function applyBadgeGrant(
  tx: DbTx,
  admin: ConfigActor & { userId: number },
  req: GrantBadgeRequest,
  badge: LockedGrantBadge,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; event: EnqueuedEvent } | BadgeDenial> {
  const [closure] = await tx
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, req.userId),
        inArray(accountDeletionRequests.status, ["pending", "completed"]),
      ),
    )
    .limit(1);
  if (closure) {
    return { ok: false, code: "closed_account", message: "不能给注销中或已注销账号授予徽章" };
  }
  if (!badge.isActive) return { ok: false, code: "not_active", message: "徽章不存在或已停用" };
  if (badge.kind === "team") {
    return { ok: false, code: "team_badge", message: "团队徽章必须通过团队成员服务授予" };
  }

  const [holder] = await tx
    .select({ userId: userBadges.userId })
    .from(userBadges)
    .where(and(eq(userBadges.userId, req.userId), eq(userBadges.badgeId, req.badgeId)))
    .limit(1);
  if (holder) return { ok: false, code: "already_held", message: "该用户已持有此徽章" };

  try {
    await tx.insert(userBadges).values({
      userId: req.userId,
      badgeId: req.badgeId,
      awardedAt: nowBeijingWallTime(),
      awardedBy: admin.userId,
    });
  } catch (e) {
    // 并发重复发放：联合主键撞键（drizzle 会包一层，isDuplicateKey 穿透 cause）→ 与「已持有」同一处理
    if (isDuplicateKey(e)) {
      return { ok: false, code: "already_held", message: "该用户已持有此徽章" };
    }
    throw e;
  }
  await writeAudit(tx, {
    actorId: admin.userId,
    action: "badge.grant",
    targetType: "user",
    targetId: req.userId,
    after: {
      badgeId: req.badgeId,
      badgeName: badge.name,
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
  const event = await enqueueEventInTx(
    tx,
    "badge.awarded",
    { userId: req.userId, badgeId: req.badgeId },
    { actorId: admin.userId, source: "badges" },
  );
  return { ok: true, event };
}

/** 后台手动授予：写 user_badges + 审计（同事务），提交后派发 badge.awarded（outbox） */
export async function grantBadgeByAdmin(
  admin: ConfigActor & { userId: number },
  req: GrantBadgeRequest,
): Promise<void> {
  let enqueued: EnqueuedEvent[] = [];
  const failure = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<BadgeDenial | null> => {
      // 每次尝试都从空开始（与 posting 同纪律）
      enqueued = [];
      const locked = await lockBadgeGrantTarget(tx, req.userId, req.badgeId);
      if (!locked.ok) return locked;
      const applied = await applyBadgeGrant(tx, admin, req, locked.badge);
      if (!applied.ok) return applied;
      enqueued.push(applied.event);
      return null;
    }, POINTS_TX_OPTIONS),
  );
  // 后台保持异常形态：denial（含并发撞键的已持有）统一转 AdminError，文案与原实现一致
  if (failure) throw new AdminError(failure.message ?? "授予被拒绝");
  await dispatchOutboxRows(enqueued);
  await sweepPending();
}

/** 收回的行锁产物：锁定的持有行即归属证明。 */
type LockedRevokeRow = { userId: number; badgeId: number };

/** 锁段（后台与 REST 共享）：user_badges 持有行 FOR UPDATE；未持有即 not_held（存在性）。 */
async function lockBadgeRevokeTarget(
  tx: DbTx,
  userId: number,
  badgeId: number,
): Promise<{ ok: true; row: LockedRevokeRow } | BadgeDenial> {
  const [row] = await tx
    .select({ userId: userBadges.userId, badgeId: userBadges.badgeId })
    .from(userBadges)
    .where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badgeId)))
    .limit(1)
    .for("update");
  if (!row) return { ok: false, code: "not_held", message: "该用户未持有此徽章" };
  return { ok: true, row };
}

/** 执行段（后台与 REST 共享）：团队徽章裁决 + 删持有行 + 审计 + 事件（同事务）。 */
async function applyBadgeRevoke(
  tx: DbTx,
  admin: ConfigActor & { userId: number },
  req: GrantBadgeRequest,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; event: EnqueuedEvent } | BadgeDenial> {
  const [badge] = await tx
    .select({ name: badges.name, kind: badges.kind })
    .from(badges)
    .where(eq(badges.id, req.badgeId))
    .limit(1);
  if (badge?.kind === "team") {
    return { ok: false, code: "team_badge", message: "团队徽章必须通过团队成员服务收回" };
  }

  await tx
    .delete(userBadges)
    .where(and(eq(userBadges.userId, req.userId), eq(userBadges.badgeId, req.badgeId)));
  await writeAudit(tx, {
    actorId: admin.userId,
    action: "badge.revoke",
    targetType: "user",
    targetId: req.userId,
    after: {
      badgeId: req.badgeId,
      badgeName: badge?.name ?? String(req.badgeId),
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
  const event = await enqueueEventInTx(
    tx,
    "badge.revoked",
    { userId: req.userId, badgeId: req.badgeId },
    { actorId: admin.userId, source: "badges" },
  );
  return { ok: true, event };
}

/** 收回徽章（M9.5 站长拍板补能力）：删持有行 + 审计 + badge.revoked 事件（通知当事人） */
export async function revokeBadgeByAdmin(
  admin: ConfigActor & { userId: number },
  req: GrantBadgeRequest,
): Promise<void> {
  const failure = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<BadgeDenial | null> => {
      const locked = await lockBadgeRevokeTarget(tx, req.userId, req.badgeId);
      if (!locked.ok) return locked;
      const applied = await applyBadgeRevoke(tx, admin, req);
      return applied.ok ? null : applied;
    }, POINTS_TX_OPTIONS),
  );
  if (failure) throw new AdminError(failure.message ?? "收回被拒绝");
  // 后台语义保持：badge.revoked 不快派（由 outbox 兜底扫描派发），仅触发补扫
  await sweepPending();
}

/** 最近授予/收回记录（M9.5）：user_badges 按 granted 时间倒序，供后台核对（不含操作者——审计有） */
export async function recentBadgeGrants(
  limit = 10,
): Promise<
  { userId: number | null; username: string | null; badgeName: string; awardedAt: string }[]
> {
  return getWebDb()
    .select({
      userId: publicUserId(users.id, users.state),
      username: publicUsername(users.username, users.state, users.id),
      badgeName: badges.name,
      awardedAt: userBadges.awardedAt,
    })
    .from(userBadges)
    .leftJoin(users, eq(users.id, userBadges.userId))
    .innerJoin(badges, eq(badges.id, userBadges.badgeId))
    .orderBy(desc(userBadges.awardedAt))
    .limit(limit);
}

// ============================================================
// REST 写变体（M20.3 Step 4）：prepare/lock/execute 三段式，供管理 REST 幂等
// 管线接入；与后台入口共享 lock/apply 内核，写入/审计/事件语义完全一致。
// 幂等契约：lock 段只做存在性与归属锁（FOR UPDATE），可变状态裁决（注销中/
// 停用/团队/已持有）统一在 execute——合法回放已被幂等缓存短路，不会重复判断；
// 事件入队留在 execute（同事务），outbox 派发与补扫放 afterCommit。
// ============================================================

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const BADGES_DENIAL_HTTP = {
  not_found: "not_found",
  not_held: "not_found",
  closed_account: "state_conflict",
  not_active: "state_conflict",
  team_badge: "state_conflict",
  already_held: "state_conflict",
} as const;

/** REST 三段式写变体的准备产物类型（data 为写响应载荷，denial 复用域拒绝码）。 */
export type PreparedApiBadgeGrant = PreparedModerationWrite<
  { userId: number; badgeId: number; granted: true },
  BadgeDenialCode
>;
export type PreparedApiBadgeRevoke = PreparedModerationWrite<
  { userId: number; badgeId: number; revoked: true },
  BadgeDenialCode
>;

/** REST 授予徽章：存在性在锁段，状态裁决/写入/事件在 execute（同一事务）。 */
export async function prepareApiBadgeGrant(
  admin: ConfigActor & { userId: number },
  userId: number,
  badgeId: number,
  trace?: ModerationApiTrace,
): Promise<PreparedApiBadgeGrant | BadgeDenial> {
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockBadgeGrantTarget(tx, userId, badgeId);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          const applied = await applyBadgeGrant(
            tx,
            admin,
            { userId, badgeId },
            locked.badge,
            trace,
          );
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: { userId, badgeId, granted: true as const },
            async afterCommit() {
              await dispatchOutboxRows([applied.event]);
              await sweepPending();
            },
          };
        },
      };
    },
  };
}

/** REST 收回徽章：持有行归属锁在锁段（未持有 → not_held），裁决与写入在 execute。 */
export async function prepareApiBadgeRevoke(
  admin: ConfigActor & { userId: number },
  userId: number,
  badgeId: number,
  trace?: ModerationApiTrace,
): Promise<PreparedApiBadgeRevoke | BadgeDenial> {
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockBadgeRevokeTarget(tx, userId, badgeId);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          const applied = await applyBadgeRevoke(tx, admin, { userId, badgeId }, trace);
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: { userId, badgeId, revoked: true as const },
            async afterCommit() {
              await dispatchOutboxRows([applied.event]);
              await sweepPending();
            },
          };
        },
      };
    },
  };
}
