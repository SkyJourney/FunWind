import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { cache } from "react";
import { badges, files, getWebDb, userBadges, users } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
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
  const rows = await getWebDb()
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
    .leftJoin(files, eq(files.id, badges.iconFileId))
    .where(
      and(
        eq(userBadges.userId, userId),
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
    .where(eq(badges.isActive, true))
    .orderBy(asc(badges.kind), asc(badges.sortOrder), asc(badges.id));
}

export interface GrantBadgeRequest {
  userId: number;
  badgeId: number;
}

/** 后台手动授予：写 user_badges + 审计（同事务），提交后派发 badge.awarded（outbox） */
export async function grantBadgeByAdmin(
  admin: ConfigActor & { userId: number },
  req: GrantBadgeRequest,
): Promise<void> {
  let enqueued: EnqueuedEvent[] = [];
  try {
    await withDeadlockRetry(() =>
      getWebDb().transaction(async (tx) => {
        // 每次尝试都从空开始（与 posting 同纪律）
        enqueued = [];
        // 目标用户必须存在且未注销（user_badges 无外键；service 层自带此不变量，不依赖调用方）
        const [holder_user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, req.userId), eq(users.state, "active")))
          .limit(1);
        if (!holder_user) throw new AdminError("目标用户不存在或已注销");

        const [badge] = await tx
          .select({ id: badges.id, name: badges.name, isActive: badges.isActive })
          .from(badges)
          .where(eq(badges.id, req.badgeId))
          .limit(1);
        if (!badge || !badge.isActive) throw new AdminError("徽章不存在或已停用");

        const [holder] = await tx
          .select({ userId: userBadges.userId })
          .from(userBadges)
          .where(and(eq(userBadges.userId, req.userId), eq(userBadges.badgeId, req.badgeId)))
          .limit(1);
        if (holder) throw new AdminError("该用户已持有此徽章");

        await tx.insert(userBadges).values({
          userId: req.userId,
          badgeId: req.badgeId,
          awardedAt: nowBeijingWallTime(),
          awardedBy: admin.userId,
        });
        await writeAudit(tx, {
          actorId: admin.userId,
          action: "badge.grant",
          targetType: "user",
          targetId: req.userId,
          after: { badgeId: req.badgeId, badgeName: badge.name, via: admin.via },
          ip: admin.ip,
        });
        enqueued.push(
          await enqueueEventInTx(
            tx,
            "badge.awarded",
            { userId: req.userId, badgeId: req.badgeId },
            { actorId: admin.userId, source: "badges" },
          ),
        );
      }, POINTS_TX_OPTIONS),
    );
  } catch (e) {
    // 并发重复发放：联合主键撞键（drizzle 会包一层，isDuplicateKey 穿透 cause）→ 与「已持有」同一处理
    if (e instanceof AdminError) throw e;
    if (isDuplicateKey(e)) throw new AdminError("该用户已持有此徽章");
    throw e;
  }
  await dispatchOutboxRows(enqueued);
  await sweepPending();
}
