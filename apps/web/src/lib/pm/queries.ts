import { and, desc, eq, sql } from "drizzle-orm";
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

  const out = [];
  for (const r of rows) {
    const [other] = await getWebDb()
      .select({ userId: conversationMembers.userId, username: users.username, state: users.state })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(
        and(
          eq(conversationMembers.conversationId, r.conversationId),
          sql`${conversationMembers.userId} <> ${userId}`,
        ),
      )
      .limit(1);
    const [{ n }] = await getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, r.conversationId),
          r.lastReadMessageId === null ? sql`1 = 1` : sql`${messages.id} > ${r.lastReadMessageId}`,
          sql`${messages.senderId} <> ${userId}`,
        ),
      );
    out.push({
      conversationId: r.conversationId,
      otherId: other?.userId ?? 0,
      otherName: other?.username ?? null,
      otherDeleted: other?.state === "deleted",
      lastMessageAt: r.lastMessageAt,
      unread: Number(n),
    });
  }
  return out;
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
