import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { conversations, conversationMembers, getWebDb, messages, users } from "@funwind/db";

/** 会话列表（最近消息倒序）+ 未读数（id 大于自己指针的对方消息数）。 */
export async function conversationList(userId: number): Promise<
  {
    conversationId: number;
    otherId: number;
    otherName: string | null;
    otherDeleted: boolean;
    lastMessageAt: string | null;
    unread: number;
  }[]
> {
  const rows = await getWebDb()
    .select({
      conversationId: conversations.id,
      lastMessageAt: conversations.lastMessageAt,
      lastReadMessageId: conversationMembers.lastReadMessageId,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(eq(conversationMembers.userId, userId))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(50);

  if (rows.length === 0) return [];

  // 一次性取对方成员与未读数（避免 2N 点查的 N+1）
  const convIds = rows.map((r) => r.conversationId);
  const others = await getWebDb()
    .select({
      conversationId: conversationMembers.conversationId,
      userId: conversationMembers.userId,
      username: users.username,
      state: users.state,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(
      and(
        inArray(conversationMembers.conversationId, convIds),
        sql`${conversationMembers.userId} <> ${userId}`,
      ),
    );
  const otherByConv = new Map(others.map((o) => [o.conversationId, o]));

  const unreadRows = await getWebDb()
    .select({ conversationId: messages.conversationId, n: sql<number>`COUNT(*)` })
    .from(messages)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, messages.conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .where(
      and(
        inArray(messages.conversationId, convIds),
        sql`(${conversationMembers.lastReadMessageId} IS NULL OR ${messages.id} > ${conversationMembers.lastReadMessageId})`,
        sql`${messages.senderId} <> ${userId}`,
      ),
    )
    .groupBy(messages.conversationId);
  const unreadByConv = new Map(unreadRows.map((r) => [r.conversationId, Number(r.n)]));

  return rows.map((r) => {
    const other = otherByConv.get(r.conversationId);
    return {
      conversationId: r.conversationId,
      otherId: other?.userId ?? 0,
      otherName: other?.username ?? null,
      otherDeleted: other?.state === "deleted",
      lastMessageAt: r.lastMessageAt,
      unread: unreadByConv.get(r.conversationId) ?? 0,
    };
  });
}

/** 会话对方的用户 id（成员资格校验与展示用） */
export async function otherMemberOf(
  conversationId: number,
  userId: number,
): Promise<number | null> {
  const [row] = await getWebDb()
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        sql`${conversationMembers.userId} <> ${userId}`,
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}
