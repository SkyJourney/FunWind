import { and, eq, sql } from "drizzle-orm";
import { getNotificationTypeDecls } from "@/modules/kernel/registry";
import { getEnabledModuleIds } from "@/modules/kernel/state";
import { getWebDb, notificationPreferences, notifications } from "@funwind/db";
import { nowBeijingWallTime } from "@/lib/datetime";
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

/** 聚合更新：同 groupKey 的未读行 count 递增、created_at 刷新、actorId 换成最近触发者 */
async function aggregateUnread(
  tx: DbTx,
  userId: number,
  type: string,
  groupKey: string,
  actorId: number | undefined,
): Promise<boolean> {
  const result = await tx
    .update(notifications)
    .set({
      actorId: actorId ?? null,
      createdAt: nowBeijingWallTime(),
      data: sqlPatchCountAndActor(actorId),
    })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, type),
        eq(notifications.groupKey, groupKey),
        sql`${notifications.readAt} IS NULL`,
      ),
    );
  return result[0].affectedRows > 0;
}

/** count 递增 + actorIds 追加最近触发者（保留最近 3 个） */
function sqlPatchCountAndActor(actorId: number | undefined) {
  const actorPatch = actorId
    ? sql`, '$.actorIds', JSON_ARRAY_APPEND(IF(JSON_TYPE(JSON_EXTRACT(data, '$.actorIds')) = 'ARRAY', JSON_EXTRACT(data, '$.actorIds'), JSON_ARRAY()), '$', ${actorId})`
    : sql`, '$.actorIds', JSON_ARRAY(${actorId ?? 0})`;
  return sql`JSON_SET(data, '$.count', CAST(IFNULL(JSON_EXTRACT(data, '$.count'), 1) AS UNSIGNED) + 1${actorPatch})`;
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
        data: {
          ...(input.data ?? {}),
          ...(decl.def.aggregate
            ? { count: 1, actorIds: input.actorId ? [input.actorId] : [] }
            : {}),
        },
        createdAt: nowBeijingWallTime(),
      });
    });
  }
}
