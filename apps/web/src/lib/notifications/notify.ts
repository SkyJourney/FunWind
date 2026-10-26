import { and, eq, isNull } from "drizzle-orm";
import { getNotificationTypeDecls } from "@/modules/kernel/registry";
import { getEnabledModuleIds } from "@/modules/kernel/state";
import { getWebDb, notificationPreferences, notifications } from "@funwind/db";
import { nowBeijingWallTime } from "@/lib/datetime";
import { isDuplicateKey } from "@/lib/auth/register";
import { isDeadlock } from "@/lib/points/retry";
import type { DbTx } from "@/lib/audit";

/**
 * 通知写入管线（M8，docs/NOTIFICATIONS.md §5 + 实现决定 1-5）：
 * 查偏好（mandatory 短路）→ 聚合（同 groupKey 未读行原位更新）→ 写库。
 * **写库失败必须抛出**——消费者抛错 = outbox 行保持 pending 补派（lib/events/outbox.ts 的 at-least-once）。
 * in_app 渠道即写表本体；模块自注册的通知渠道（email/push）M8 无实现，接口留待后续。
 */

export interface NotifyInput {
  type: string;
  recipients: readonly number[];
  actorId?: number;
  targetType?: string;
  targetId?: number;
  /** 聚合键（类型 aggregate=true 时必填） */
  groupKey?: string;
  /**
   * 幂等键（M8 审查挂账兑现，迁移 0008）：非聚合通知携带后 at-least-once 重放撞唯一索引跳过。
   * 同一业务动作对同一接收人应稳定（如 `mod:{postId}:reject:{userId}`）；聚合类型不适用（行原位更新）。
   */
  dedupKey?: (userId: number) => string;
  data?: Record<string, unknown>;
}

/** 用户偏好：无记录 = in_app 开；返回 false 表示该用户关掉了此类型的站内通知 */
export async function inAppEnabled(tx: DbTx, userId: number, type: string): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.type, type),
        eq(notificationPreferences.channel, "in_app"),
      ),
    )
    .limit(1);
  return row?.enabled ?? true;
}

/**
 * 聚合更新（M8 审查整改版）：行锁（FOR UPDATE）内 JS 合成整行——
 * count+1、actorIds 前插最近触发者并**截断到 5 个**（此前只追加不截断，热帖 data 无限膨胀；
 * 且 actorId 缺省分支会写 [0] 假数据）、created_at 刷新。
 * 并发防护：唯一索引 uq_nf_open_group 兜底「双 INSERT 双行」（历史竞态产生的重复行已由迁移 0007 去重）。
 * 返回 true 表示已聚合（无需新插）。
 */
async function aggregateUnread(
  tx: DbTx,
  userId: number,
  type: string,
  groupKey: string,
  actorId: number | undefined,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: notifications.id, data: notifications.data })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, type),
        eq(notifications.groupKey, groupKey),
        isNull(notifications.readAt),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) return false;
  const prev = (row.data ?? {}) as { count?: number; actorIds?: number[] };
  const nextActors =
    actorId !== undefined
      ? [actorId, ...(Array.isArray(prev.actorIds) ? prev.actorIds : [])].slice(0, 5)
      : Array.isArray(prev.actorIds)
        ? prev.actorIds.slice(0, 5)
        : [];
  const nextData = {
    ...prev,
    count: (typeof prev.count === "number" ? prev.count : 1) + 1,
    actorIds: nextActors,
  };
  await tx
    .update(notifications)
    .set({
      actorId: actorId ?? null,
      createdAt: nowBeijingWallTime(),
      data: nextData,
    })
    .where(eq(notifications.id, row.id));
  return true;
}

/**
 * 发通知（供模块 events 消费者调用）。recipients 中的触发者本人是否排除由消费者决定
 * （互动类排除、安全类不排除）；这里只做偏好、聚合与落库。
 * 类型未注册（或所属模块停用）→ 抛错：调用方是消费者，抛错 = 补派，不是静默丢失。
 */
export async function notify(input: NotifyInput): Promise<void> {
  const enabled = await getEnabledModuleIds();
  const decl = getNotificationTypeDecls().find(
    (d) => d.def.key === input.type && enabled.has(d.moduleId),
  );
  if (!decl) throw new Error(`[notify] 未注册或停用的通知类型: ${input.type}`);
  if (decl.def.aggregate && !input.groupKey) {
    throw new Error(`[notify] 聚合类型缺少 groupKey: ${input.type}`);
  }

  const db = getWebDb();
  for (const userId of new Set(input.recipients)) {
    if (userId <= 0) continue;
    // 重试一次：并发双 INSERT 时唯一索引 uq_nf_open_group 让败者抛 duplicate key——
    // 重跑整笔（胜者行已提交，FOR UPDATE 聚合路径命中）。（事务已回滚，重放安全）
    for (let attempt = 1; ; attempt++) {
      try {
        await db.transaction(async (tx) => {
          // mandatory 短路偏好（docs/NOTIFICATIONS.md 实现决定 3）
          if (!decl.def.mandatory && !(await inAppEnabled(tx, userId, input.type))) return;

          if (decl.def.aggregate && input.groupKey) {
            const updated = await aggregateUnread(
              tx,
              userId,
              input.type,
              input.groupKey,
              input.actorId,
            );
            if (updated) return;
          }
          await tx.insert(notifications).values({
            userId,
            category: decl.def.category,
            type: input.type,
            actorId: input.actorId ?? null,
            targetType: input.targetType ?? "",
            targetId: input.targetId ?? 0,
            groupKey: input.groupKey ?? null,
            dedupKey: input.dedupKey?.(userId) ?? null,
            data: {
              ...(input.data ?? {}),
              ...(decl.def.aggregate
                ? { count: 1, actorIds: input.actorId !== undefined ? [input.actorId] : [] }
                : {}),
            },
            createdAt: nowBeijingWallTime(),
          });
        });
        break;
      } catch (e) {
        // 聚合并发：撞 uq_nf_open_group（duplicate key）或间隙锁死锁（ER_LOCK_DEADLOCK）
        //   → 重跑整笔（胜者行已提交，FOR UPDATE 聚合路径命中）。事务已回滚，重放安全。
        // dedup 重放：撞 uq_nf_dedup → 幂等跳过（成功返回）。
        if (
          attempt < 5 &&
          (isDuplicateKey(e) || isDeadlock(e)) &&
          decl.def.aggregate &&
          input.groupKey
        ) {
          continue;
        }
        if (isDuplicateKey(e) && input.dedupKey) break;
        throw e;
      }
    }
  }
}
