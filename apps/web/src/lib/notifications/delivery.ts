import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { eventOutbox, getWebDb, notificationDeliveries } from "@funwind/db";
import { DeliveryTransportError } from "@/lib/net/delivery-error";
import { MODERATION_NOTIFICATION_DELIVERY_POLICY } from "@/modules/kernel/types";

type NotificationDelivery = { outboxId: number; recipientId: number } & (
  { channel: "email"; scene: "content.approved" } | { channel: "push"; scene: "post.replied" }
);

/** 只吸收本台账主键冲突，不把触发器或其它表的写入错误误认为已发送。 */
function isReserved(error: unknown): boolean {
  type MysqlError = { code?: string; errno?: number; sqlMessage?: string };
  const err = error as (MysqlError & { cause?: MysqlError }) | null | undefined;
  return [err, err?.cause].some(
    (e) =>
      (e?.code === "ER_DUP_ENTRY" || e?.errno === 1062) &&
      e.sqlMessage?.endsWith("'notification_deliveries.PRIMARY'"),
  );
}

/** 先提交唯一占位；过期或已占位不发送。占位事务出错时留给 outbox 补派。 */
async function reserve(delivery: NotificationDelivery): Promise<boolean> {
  try {
    return await getWebDb().transaction(async (tx) => {
      const [event] = await tx
        .select({ id: eventOutbox.id })
        .from(eventOutbox)
        .where(
          and(
            eq(eventOutbox.id, delivery.outboxId),
            eq(
              eventOutbox.eventName,
              delivery.channel === "email" ? "content.moderated" : "thread.replied",
            ),
            eq(eventOutbox.deliveryPolicy, MODERATION_NOTIFICATION_DELIVERY_POLICY),
            sql`${eventOutbox.createdAt} > NOW() - INTERVAL 90 DAY`,
          ),
        )
        .limit(1);
      if (!event) return false;
      await tx
        .insert(notificationDeliveries)
        .values({ ...delivery, status: "uncertain", createdAt: sql`NOW()` });
      return true;
    });
  } catch (error) {
    if (isReserved(error)) return false;
    throw error;
  }
}

/** 外送最多尝试一次；预写的结果不明足以保护崩溃或结果落库失败后的重放。 */
export async function deliverModerationNotification(
  delivery: NotificationDelivery,
  send: () => Promise<void>,
): Promise<boolean> {
  if (!(await reserve(delivery))) return false;
  let status: "sent" | "failed" | "uncertain";
  try {
    await send();
    status = "sent";
  } catch (error) {
    status =
      error instanceof DeliveryTransportError && error.outcome === "failed"
        ? "failed"
        : "uncertain";
  }
  try {
    await getWebDb()
      .update(notificationDeliveries)
      .set({ status, finishedAt: sql`NOW()` })
      .where(
        and(
          eq(notificationDeliveries.outboxId, delivery.outboxId),
          eq(notificationDeliveries.channel, delivery.channel),
          eq(notificationDeliveries.scene, delivery.scene),
          eq(notificationDeliveries.recipientId, delivery.recipientId),
        ),
      );
  } catch {
    console.error("[notify-delivery] delivery_result_write_failed", {
      outboxId: delivery.outboxId,
      channel: delivery.channel,
      scene: delivery.scene,
    });
  }
  return status === "sent";
}
