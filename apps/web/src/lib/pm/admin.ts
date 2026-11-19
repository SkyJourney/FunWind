import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { conversations, getWebDb, messages, users } from "@funwind/db";
import type { ConfigActor, DbTx } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { AdminError } from "@/lib/authz/admin";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";
import { pageBounds } from "@/lib/paging";

/**
 * 私信管理（M10 补做）：删除违规消息（软处理——标记正文，保留审计）与封禁私信
 * （对发送者施加 mute 限制，复用 M9 限制管理）。
 * 权限：site.admin（私信无版块作用域，两级中的站点级）。
 */

/** 私信删除的域拒绝码：理由缺失类与不存在（后台转 AdminError，REST 走 denial 信封）。 */
export type PmDeleteDenialCode = "reason_required" | "not_found";
type PmDeleteDenial = ModerationWriteDenial<PmDeleteDenialCode>;

/** 输入校验（后台与 REST 共享，事务外）：理由必填（trim 后非空）。 */
function planMessageDelete(reason: string): { ok: true; trimmed: string } | PmDeleteDenial {
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, code: "reason_required", message: "必须填写删除理由" };
  return { ok: true, trimmed };
}

/** 锁段（后台与 REST 共享）：行锁取消息行；软删不做任何可变状态裁决。 */
async function lockMessageRow(
  tx: DbTx,
  messageId: number,
): Promise<
  | { ok: true; row: { id: number; conversationId: number; senderId: number | null; body: string } }
  | PmDeleteDenial
> {
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
  if (!row) return { ok: false, code: "not_found", message: "消息不存在" };
  return { ok: true, row };
}

/** 执行段（后台与 REST 共享）：正文覆写软删 + 审计；trace 仅 REST 传入时附加到审计 after。 */
async function applyMessageDelete(
  tx: DbTx,
  admin: ConfigActor & { userId: number },
  messageId: number,
  row: { body: string },
  trimmed: string,
  trace?: ModerationApiTrace,
): Promise<void> {
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
    after: {
      reason: trimmed,
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
}

/** 违规消息删除：正文清空并标记（保留行以维持消息序号连续与审计追溯） */
export async function deleteMessage(
  admin: ConfigActor & { userId: number },
  messageId: number,
  reason: string,
): Promise<void> {
  const planned = planMessageDelete(reason);
  if (!planned.ok) throw new AdminError(planned.message ?? "必须填写删除理由");
  const failure = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<PmDeleteDenial | null> => {
      const locked = await lockMessageRow(tx, messageId);
      if (!locked.ok) return locked;
      await applyMessageDelete(tx, admin, messageId, locked.row, planned.trimmed);
      return null;
    }, POINTS_TX_OPTIONS),
  );
  // 后台保持异常形态：denial 统一转 AdminError，文案与原实现一致
  if (failure) throw new AdminError(failure.message ?? "消息不存在");
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

/** 私信管理列表分页（M9.5；M19 S4 加时间范围）：筛选下推 SQL，替代原「取最近 50 条后内存过滤」。
 *  注意：messages 表无时间/发送者索引（仅 idx_msg_conv），时间筛选为扫描——当前量级（重启后新数据）可接受。 */
export type PmPageFilters = {
  /** 纯数字 = 发送者 uid 等值；非空 = 用户名精确匹配反查 uid */
  q?: string;
  /** 发送时间下界（含） */
  since?: string;
  /** 发送时间上界（含当天——调用方传 `${date} 23:59:59`） */
  until?: string;
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
  page: number;
  totalPages: number;
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
      if (!u) return { items: [], total: 0, page: 1, totalPages: 1, unknownUser: true };
      senderFilter = u.id;
    }
  }

  const conds: SQL[] = [];
  if (senderFilter !== null) conds.push(eq(messages.senderId, senderFilter));
  if (filters.since) conds.push(gte(messages.createdAt, filters.since));
  if (filters.until) conds.push(lte(messages.createdAt, filters.until));
  const where = conds.length > 0 ? and(...conds) : undefined;
  const [countRow] = await getWebDb()
    .select({ total: sql<number>`COUNT(*)` })
    .from(messages)
    .where(where);
  const total = Number(countRow?.total ?? 0);
  const { page, totalPages, offset } = pageBounds(total, filters.page, perPage);
  const rows = await getWebDb()
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
    .offset(offset);
  return { items: rows, total, page, totalPages, unknownUser };
}

// ============================================================
// REST 写变体（M20.3 Step 4）：prepare/lock/execute 三段式，供管理 REST 幂等
// 管线接入；与后台入口共享 plan/lock/apply 内核，写入与审计语义完全一致。
// 幂等契约：lock 段只做存在性锁（软删无额外可变状态裁决），execute 在幂等
// 管线的外层事务内覆写+审计（闭包捕获 lock 的 tx，不另开事务）；合法回放
// 已被缓存短路，不会重复写。
// ============================================================

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const PM_DENIAL_HTTP = {
  reason_required: "bad_request",
  not_found: "not_found",
} as const;

/** REST 三段式写变体的准备产物类型（data 为写响应载荷，denial 复用域拒绝码）。 */
export type PreparedApiPmMessageDelete = PreparedModerationWrite<
  { messageId: number; deleted: true },
  PmDeleteDenialCode
>;

/** REST 删除违规消息：理由校验在 prepare（事务外），行锁取行在 lock 段，覆写+审计在 execute。 */
export async function prepareApiPmMessageDelete(
  admin: ConfigActor & { userId: number },
  messageId: number,
  reason: string,
  trace?: ModerationApiTrace,
): Promise<PreparedApiPmMessageDelete | PmDeleteDenial> {
  const planned = planMessageDelete(reason);
  if (!planned.ok) return planned;
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockMessageRow(tx, messageId);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          await applyMessageDelete(tx, admin, messageId, locked.row, planned.trimmed, trace);
          return { ok: true as const, data: { messageId, deleted: true as const } };
        },
      };
    },
  };
}
