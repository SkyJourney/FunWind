import { desc, eq, sql } from "drizzle-orm";
import { conversations, getWebDb, messages, users } from "@funwind/db";
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

/** 会话总数与消息总数（看板/列表头）。双全表 COUNT 进页即扫，60s 进程内缓存（M9.5） */
let pmStatsCache: {
  at: number;
  value: { conversations: number; messages: number; today: number };
} | null = null;
const PM_STATS_TTL_MS = 60_000;

export async function pmStats(): Promise<{
  conversations: number;
  messages: number;
  today: number;
}> {
  if (pmStatsCache && Date.now() - pmStatsCache.at < PM_STATS_TTL_MS) return pmStatsCache.value;
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
  const value = {
    conversations: Number(c?.n ?? 0),
    messages: Number(m?.n ?? 0),
    today: Number(t?.n ?? 0),
  };
  pmStatsCache = { at: Date.now(), value };
  return value;
}

/** 私信管理列表分页（M9.5）：筛选下推 SQL，替代原「取最近 50 条后内存过滤」（更早的消息永远筛不到） */
export type PmPageFilters = {
  /** 纯数字 = 发送者 uid 等值；非空 = 用户名精确匹配反查 uid */
  q?: string;
  page: number;
  perPage?: number;
};

export async function listPmMessagesPage(filters: PmPageFilters): Promise<{
  items: {
    id: number;
    conversationId: number;
    senderId: number | null;
    body: string;
    createdAt: string;
  }[];
  total: number;
  /** 用户名筛选命中不到人时的提示（与「无消息」区分） */
  unknownUser: boolean;
}> {
  const perPage = filters.perPage ?? 20;
  const q = filters.q?.trim() ?? "";
  let senderFilter: number | null = null;
  const unknownUser = false;
  if (q) {
    if (/^\d+$/.test(q)) {
      senderFilter = Number(q);
    } else {
      const [u] = await getWebDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, q))
        .limit(1);
      if (!u) return { items: [], total: 0, unknownUser: true };
      senderFilter = u.id;
    }
  }

  const where = senderFilter !== null ? eq(messages.senderId, senderFilter) : undefined;
  const [countRow, rows] = await Promise.all([
    getWebDb()
      .select({ total: sql<number>`COUNT(*)` })
      .from(messages)
      .where(where),
    getWebDb()
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        senderId: messages.senderId,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(where)
      .orderBy(desc(messages.id))
      .limit(perPage)
      .offset((filters.page - 1) * perPage),
  ]);
  return { items: rows, total: Number(countRow[0]?.total ?? 0), unknownUser };
}
