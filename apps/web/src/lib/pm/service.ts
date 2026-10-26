import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  conversations,
  conversationMembers,
  getWebDb,
  messages,
  notifications,
  users,
} from "@funwind/db";
import type { Subject } from "@/lib/authz/types";
import { checkPermission } from "@/lib/authz/service";
import { nowBeijingWallTime } from "@/lib/datetime";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { limitsFor } from "@/lib/limits/load";
import { enqueueEventInTx, sweepPending } from "@/lib/events/outbox";
import { isDuplicateKey } from "@/lib/auth/register";

/**
 * 私信（M10）：pairKey="小uid:大uid"（uq_conv_pair）一队一会话；发送事务=消息+成员 upsert+会话指针+
 * message.sent 入 outbox（M8-1 收尾）；额度 limits.roles.pmPerDay（兑现旧 message_max_send；0=不限）。
 * 已读唯一来源 last_read_message_id；openConversation 推进指针并清理该会话未读 pm.received 行
 * （openGroupKey 随 read_at 变 NULL，新私信自动新开一行）。禁言/封禁自动拦 pm.send（写类权限）。
 */

export type SendCode =
  "login" | "not_found" | "forbidden" | "self" | "reason_required" | "quota_exceeded";

export type SendResult =
  { ok: true; conversationId: number } | { ok: false; code: SendCode; message: string };

const pairKeyOf = (a: number, b: number): string => {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${lo}:${hi}`;
};

/** 发送私信（会话不存在则创建；并发首信撞 uq_conv_pair 后读回既有会话）。 */
export async function sendMessage(
  viewer: Subject,
  recipientId: number,
  body: string,
): Promise<SendResult> {
  if (viewer.userId === null) return { ok: false, code: "login", message: "请先登录" };
  const senderId = viewer.userId;
  if (recipientId === senderId) return { ok: false, code: "self", message: "不能给自己发私信" };
  const text = body.trim();
  if (!text) return { ok: false, code: "reason_required", message: "内容不能为空" };
  if (text.length > 5000)
    return { ok: false, code: "reason_required", message: "内容过长（≤5000 字）" };
  if (!(await checkPermission(viewer, "pm.send")).allowed) {
    return { ok: false, code: "forbidden", message: "你没有发送私信的权限（可能被禁言）" };
  }
  const [recipient] = await getWebDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, recipientId), eq(users.state, "active")))
    .limit(1);
  if (!recipient) return { ok: false, code: "not_found", message: "对方不存在或已注销" };

  const limits = await limitsFor(viewer);
  const perDay = limits.pmPerDay ?? 0;
  if (perDay > 0) {
    const [{ n }] = await getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(messages)
      .where(and(eq(messages.senderId, senderId), sql`DATE(${messages.createdAt}) = CURDATE()`));
    if (Number(n) >= perDay) {
      return { ok: false, code: "quota_exceeded", message: `今日私信已达上限（${perDay} 条）` };
    }
  }

  const pairKey = pairKeyOf(senderId, recipientId);
  const failure = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<SendResult | null> => {
      let conversationId: number;
      const [existing] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.pairKey, pairKey))
        .limit(1);
      if (existing) {
        conversationId = existing.id;
      } else {
        try {
          const [created] = (await tx
            .insert(conversations)
            .values({ pairKey, createdAt: nowBeijingWallTime() })) as unknown as [
            { insertId: number },
          ];
          conversationId = Number(created.insertId);
          await tx.insert(conversationMembers).values([
            { conversationId, userId: senderId },
            { conversationId, userId: recipientId },
          ]);
        } catch (e) {
          // 并发首信：撞 uq_conv_pair → 读回既有会话并补齐成员（幂等 upsert）
          if (!isDuplicateKey(e)) throw e;
          const [raced] = await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.pairKey, pairKey))
            .limit(1);
          if (!raced) throw e;
          conversationId = raced.id;
          await tx
            .insert(conversationMembers)
            .values([
              { conversationId, userId: senderId },
              { conversationId, userId: recipientId },
            ])
            .onDuplicateKeyUpdate({ set: { userId: sql`${conversationMembers.userId}` } });
        }
      }

      const [msgRow] = (await tx.insert(messages).values({
        conversationId,
        senderId,
        body: text,
        createdAt: nowBeijingWallTime(),
      })) as unknown as [{ insertId: number }];
      await tx
        .update(conversations)
        .set({ lastMessageAt: nowBeijingWallTime() })
        .where(eq(conversations.id, conversationId));

      await enqueueEventInTx(
        tx,
        "message.sent",
        { conversationId, messageId: Number(msgRow.insertId), senderId, recipientId },
        { actorId: senderId, source: "pm" },
      );
      return null;
    }, POINTS_TX_OPTIONS),
  );
  if (failure) return failure;

  const [conv] = await getWebDb()
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.pairKey, pairKey))
    .limit(1);
  await sweepPending();
  return { ok: true, conversationId: conv?.id ?? 0 };
}

/** 打开会话：成员校验 + 联动已读（指针推进 + 该会话未读 pm.received 清零，同事务）。返回是否成员。 */
export async function openConversation(userId: number, conversationId: number): Promise<boolean> {
  const [member] = await getWebDb()
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!member) return false;

  await getWebDb().transaction(async (tx) => {
    const [latest] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.id))
      .limit(1);
    if (latest) {
      await tx
        .update(conversationMembers)
        .set({ lastReadMessageId: latest.id })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, userId),
          ),
        );
    }
    await tx
      .update(notifications)
      .set({ readAt: nowBeijingWallTime() })
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, "pm.received"),
          eq(notifications.groupKey, `conv:${conversationId}:pm`),
          sql`read_at IS NULL`,
        ),
      );
  });
  return true;
}

/** 对话页消息分页（M10 补做）：升序、取尾页（最新消息在底部，与聊天习惯一致）。 */
export const PM_MESSAGES_PER_PAGE = 30;

export async function conversationMessages(
  conversationId: number,
  page = 1,
  pageSize = PM_MESSAGES_PER_PAGE,
): Promise<{
  items: { id: number; senderId: number; body: string; createdAt: string }[];
  total: number;
  page: number;
  totalPages: number;
}> {
  const [{ n }] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  const total = Number(n);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const items =
    total === 0
      ? []
      : await getWebDb()
          .select({
            id: messages.id,
            senderId: messages.senderId,
            body: messages.body,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .orderBy(asc(messages.id))
          .limit(pageSize)
          .offset((safePage - 1) * pageSize);
  return { items, total, page: safePage, totalPages };
}
