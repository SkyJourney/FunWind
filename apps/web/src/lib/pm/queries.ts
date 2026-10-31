import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { conversations, conversationMembers, getWebDb, messages, users } from "@funwind/db";
import { publicUserDeleted, publicUserId, publicUsername } from "@/lib/queries/public-identity";
import { pageBounds } from "@/lib/queries/paging";

export interface ConversationItem {
  conversationId: number;
  otherId: number | null;
  otherName: string | null;
  otherDeleted: boolean;
  lastMessageAt: string | null;
  unread: number;
  /** 会话内最新一条的发送者与正文（列表预览；senderIsSelf 用于「我：」前缀） */
  preview: { senderIsSelf: boolean; body: string } | null;
}

/** 会话列表单次加载的上限（未分页的旧入口用；分页入口见 conversationPage） */
const CONVERSATION_LIST_LIMIT = 50;

/** 会话列表（最近消息倒序）+ 未读数（id 大于自己指针的对方消息数）+ 最后一条预览。 */
export async function conversationList(userId: number): Promise<ConversationItem[]> {
  return loadConversations(userId, CONVERSATION_LIST_LIMIT, 0);
}

/** 流式列表每页条数（/messages 与 /api/stream/conversations 共用） */
export const CONVERSATIONS_PER_PAGE = 20;

/**
 * 会话列表分页（M10.7）：取 perPage+1 条判断是否还有下一页，消除 conversationList 对 50 个会话的静默截断。
 * 未读数与预览是请求时刻的快照；追加页不做实时刷新。
 */
export async function conversationPage(
  userId: number,
  rawPage: number,
): Promise<{ items: ConversationItem[]; hasMore: boolean; page: number }> {
  // 会话流不做总数统计；按安全整数上限夹取页码，确保 OFFSET 可表示。
  const { page, offset } = pageBounds(Number.MAX_SAFE_INTEGER, rawPage, CONVERSATIONS_PER_PAGE);
  const rows = await loadConversations(userId, CONVERSATIONS_PER_PAGE + 1, offset);
  return {
    items: rows.slice(0, CONVERSATIONS_PER_PAGE),
    hasMore: rows.length > CONVERSATIONS_PER_PAGE,
    page,
  };
}

async function loadConversations(
  userId: number,
  limit: number,
  offset: number,
): Promise<ConversationItem[]> {
  const rows = await getWebDb()
    .select({
      conversationId: conversations.id,
      lastMessageAt: conversations.lastMessageAt,
      lastReadMessageId: conversationMembers.lastReadMessageId,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(eq(conversationMembers.userId, userId))
    // id 作为第二排序键：lastMessageAt 相同（同一秒内的会话）时翻页顺序也必须稳定
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(limit)
    .offset(offset);

  if (rows.length === 0) return [];

  // 一次性取对方成员与未读数（避免 2N 点查的 N+1）
  const convIds = rows.map((r) => r.conversationId);
  const others = await getWebDb()
    .select({
      conversationId: conversationMembers.conversationId,
      userId: publicUserId(users.id, users.state),
      username: publicUsername(users.username, users.state, users.id),
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
        or(isNull(messages.senderId), ne(messages.senderId, userId)),
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
      otherId: other === undefined ? 0 : other.userId,
      otherName: other?.username ?? null,
      otherDeleted: other?.userId === null,
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
    .select({ userId: publicUserId(users.id, users.state) })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        sql`${conversationMembers.userId} <> ${userId}`,
        eq(users.state, "active"),
        sql`NOT ${publicUserDeleted(users.id, users.state)}`,
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

export async function otherMemberSummaryOf(
  conversationId: number,
  userId: number,
): Promise<{ userId: number | null; displayName: string; deleted: boolean } | null> {
  const [row] = await getWebDb()
    .select({
      userId: publicUserId(users.id, users.state),
      username: publicUsername(users.username, users.state, users.id),
      deleted: publicUserDeleted(users.id, users.state).mapWith(Boolean),
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        sql`${conversationMembers.userId} <> ${userId}`,
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.deleted) return { userId: null, displayName: "已注销用户", deleted: true };
  return { userId: row.userId, displayName: row.username ?? "未知用户", deleted: false };
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
        or(isNull(messages.senderId), ne(messages.senderId, userId)),
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

/** 聊天页单批消息条数（首屏最新一批与上滑加载的每批都用它） */
export const CHAT_BATCH = 30;

export interface ChatMessage {
  id: number;
  senderId: number | null;
  body: string;
  createdAt: string;
}

/** 是否为会话成员（只读校验：不像 openConversation 那样推进已读指针） */
export async function isConversationMember(
  userId: number,
  conversationId: number,
): Promise<boolean> {
  const [row] = await getWebDb()
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * 聊天消息的游标分页（M10.7 Step 3c）：取 id 小于 `beforeId` 的最新一批（缺省 = 会话里最新的一批），
 * 返回按 id **升序**（旧→新，直接是聊天的阅读顺序）。多取 1 条判断是否还有更早的消息。
 * 用 id 作游标而不是页码偏移：消息只增不改，新消息到达不会让「更早」的边界错位。
 */
export async function messagesBefore(
  conversationId: number,
  beforeId: number | null,
  limit = CHAT_BATCH,
): Promise<{ items: ChatMessage[]; hasMore: boolean }> {
  const rows = await getWebDb()
    .select({
      id: messages.id,
      senderId: publicUserId(users.id, users.state),
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        beforeId === null ? undefined : sql`${messages.id} < ${beforeId}`,
      ),
    )
    .orderBy(desc(messages.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}
