import { desc, eq, sql } from "drizzle-orm";
import { conversations, getWebDb, messages } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { AdminError } from "@/lib/authz/admin";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";

/**
 * 私信管理（M10 补做）：删除违规消息（软处理——标记正文，保留审计）与封禁私信
 * （对发送者施加 mute 限制，复用 M9 限制管理）。
 * 权限：site.admin（私信无版块作用域，两级中的站点级）。
 */

/** 违规消息删除：正文清空并标记（保留行以维持消息序号连续与审计追溯） */
export async function deleteMessage(
  admin: ConfigActor & { userId: number },
  messageId: number,
  reason: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new AdminError("必须填写删除理由");
  await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          senderId: messages.senderId,
          body: messages.body,
        })
        .from(messages)
        .where(eq(messages.id, messageId))
        .for("update");
      if (!row) throw new AdminError("消息不存在");

      await tx
        .update(messages)
        .set({ body: `[已由管理员删除：${trimmed}]` })
        .where(eq(messages.id, messageId));
      await writeAudit(tx, {
        actorId: admin.userId,
        action: "pm.message.delete",
        targetType: "message",
        targetId: messageId,
        before: { body: row.body },
        after: { reason: trimmed, via: admin.via },
        ip: admin.ip,
      });
    }, POINTS_TX_OPTIONS),
  );
}

/** 会话总数与消息总数（看板/列表头） */
export async function pmStats(): Promise<{
  conversations: number;
  messages: number;
  today: number;
}> {
  const [[c], [m], [t]] = await Promise.all([
    getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(conversations),
    getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(messages),
    getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(messages)
      .where(sql`DATE(${messages.createdAt}) = CURDATE()`),
  ]);
  return {
    conversations: Number(c?.n ?? 0),
    messages: Number(m?.n ?? 0),
    today: Number(t?.n ?? 0),
  };
}

/** 最近消息（跨会话，管理视角）：定位违规内容 */
export async function recentMessages(
  limit = 30,
): Promise<
  { id: number; conversationId: number; senderId: number; body: string; createdAt: string }[]
> {
  return getWebDb()
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .orderBy(desc(messages.id))
    .limit(limit);
}
