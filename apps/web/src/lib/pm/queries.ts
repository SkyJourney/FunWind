import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { conversations, conversationMembers, getWebDb, messages, users } from "@funwind/db";

/** 会话列表（最近消息倒序）+ 未读数（id 大于自己指针的对方消息数）+ 最后一条预览。 */
export async function conversationList(userId: number): Promise<
  {
    conversationId: number;
    otherId: number;
    otherName: string | null;
    otherDeleted: boolean;
    lastMessageAt: string | null;
    unread: number;
    /** 会话内最新一条的发送者与正文（列表预览；senderIsSelf 用于「我：」前缀） */
    preview: { senderIsSelf: boolean; body: string } | null;
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

  // 每会话最新一条（窗口函数取 per-group 最大 id，再取正文）
  const latestRows = await getWebDb()
    .select({
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      body: messages.body,
    })
    .from(messages)
    .where(
      inArray(
        messages.id,
        getWebDb()
          .select({ mid: sql<number>`MAX(${messages.id})` })
          .from(messages)
          .where(inArray(messages.conversationId, convIds))
          .groupBy(messages.conversationId),
      ),
    );
  const latestByConv = new Map(latestRows.map((m) => [m.conversationId, m]));

  return rows.map((r) => {
    const other = otherByConv.get(r.conversationId);
    const latest = latestByConv.get(r.conversationId);
    return {
      conversationId: r.conversationId,
      otherId: other?.userId ?? 0,
      otherName: other?.username ?? null,
      otherDeleted: other?.state === "deleted",
      lastMessageAt: r.lastMessageAt,
      unread: unreadByConv.get(r.conversationId) ?? 0,
      preview:
        latest === undefined
          ? null
          : {
              senderIsSelf: latest.senderId === userId,
              body: latest.body.length > 60 ? `${latest.body.slice(0, 60)}…` : latest.body,
            },
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

/** 全站未读私信总数（顶栏/底部导航角标）：与 conversationList 的未读口径一致（指针之后的对方消息）。 */
export async function unreadPmTotal(userId: number): Promise<number> {
  // 无 GROUP BY 的 COUNT 恒返回一行
  const [row] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
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
        sql`(${conversationMembers.lastReadMessageId} IS NULL OR ${messages.id} > ${conversationMembers.lastReadMessageId})`,
        sql`${messages.senderId} <> ${userId}`,
      ),
    );
  return Number(row.n);
}

/** 本人今日已发送条数（对话页额度提示；口径与 service 的 quota 校验一致：自然日）。 */
export async function sentTodayCount(userId: number): Promise<number> {
  const [row] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(messages)
    .where(and(eq(messages.senderId, userId), sql`DATE(${messages.createdAt}) = CURDATE()`));
  return Number(row.n);
}
