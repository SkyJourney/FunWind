import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getWebDb, pointAccounts, sessions, userRestrictions, userRoles, users } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";

/**
 * 限制管理（M9）：封禁/禁言/禁头像的创建与解除。同事务写审计；restriction.changed 经 outbox
 * （notifications 模块消费 → account.restricted / restriction_lifted 强制通知）。
 * kind 语义沿用 M4/M5：ban（封禁）/ mute（禁言）/ no_avatar / no_signature；scope 0=全站。
 */

export type RestrictionKind = "ban" | "mute" | "no_avatar" | "no_signature";

export type RestrictionResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "bad_kind" | "reason_required" | "already" | "bad_scope" };

const KINDS: readonly RestrictionKind[] = ["ban", "mute", "no_avatar", "no_signature"];

/** 创建限制（可带结束时间；endsAt=null 永久）。同一 kind 的有效行已存在 → already（先解除再建新的） */
export async function createRestriction(
  admin: ConfigActor & { userId: number },
  input: { userId: number; kind: string; reason: string; endsAt: string | null; scopeId?: number },
): Promise<RestrictionResult> {
  if (!KINDS.includes(input.kind as RestrictionKind)) return { ok: false, code: "bad_kind" };
  const kind = input.kind as RestrictionKind;
  const reason = input.reason.trim();
  if (!reason) return { ok: false, code: "reason_required" };
  const scopeId = input.scopeId ?? 0;
  if (!Number.isInteger(scopeId) || scopeId < 0) return { ok: false, code: "bad_scope" };

  const enqueued: EnqueuedEvent[] = [];
  const failure = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<RestrictionResult | null> => {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!user) return { ok: false, code: "not_found" };

      const [active] = await tx
        .select({ id: userRestrictions.id })
        .from(userRestrictions)
        .where(
          and(
            eq(userRestrictions.userId, input.userId),
            eq(userRestrictions.kind, kind),
            eq(userRestrictions.scopeId, scopeId),
            or(isNull(userRestrictions.endsAt), sql`${userRestrictions.endsAt} > NOW()`),
          ),
        )
        .limit(1);
      if (active) return { ok: false, code: "already" };

      const endsAt = input.endsAt && input.endsAt !== "" ? input.endsAt : null;
      await tx.insert(userRestrictions).values({
        userId: input.userId,
        kind,
        scopeId,
        reason,
        startsAt: nowBeijingWallTime(),
        endsAt,
        createdBy: admin.userId,
        createdAt: nowBeijingWallTime(),
      });
      await writeAudit(tx, {
        actorId: admin.userId,
        action: "restriction.create",
        targetType: "user",
        targetId: input.userId,
        after: { kind, scopeId, reason, endsAt, via: admin.via },
        ip: admin.ip,
      });
      enqueued.push(
        await enqueueEventInTx(
          tx,
          "restriction.changed",
          {
            userId: input.userId,
            kind,
            action: "created",
            operatorId: admin.userId,
            reason,
            endsAt,
          },
          { actorId: admin.userId, source: "admin" },
        ),
      );
      return null;
    }, POINTS_TX_OPTIONS),
  );
  if (failure) return failure;
  await dispatchOutboxRows(enqueued);
  await sweepPending();
  return { ok: true };
}

/** 解除限制（按行 id） */
export async function liftRestriction(
  admin: ConfigActor & { userId: number },
  restrictionId: number,
  note: string,
): Promise<RestrictionResult> {
  const trimmed = note.trim();
  if (!trimmed) return { ok: false, code: "reason_required" };

  const enqueued: EnqueuedEvent[] = [];
  const failure = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<RestrictionResult | null> => {
      const [row] = await tx
        .select({
          id: userRestrictions.id,
          userId: userRestrictions.userId,
          kind: userRestrictions.kind,
          endsAt: userRestrictions.endsAt,
        })
        .from(userRestrictions)
        .where(eq(userRestrictions.id, restrictionId))
        .for("update");
      if (!row) return { ok: false, code: "not_found" };

      // 已过期的不必解除
      if (row.endsAt !== null && row.endsAt <= nowBeijingWallTime()) {
        return { ok: false, code: "already" };
      }

      await tx
        .update(userRestrictions)
        .set({ endsAt: nowBeijingWallTime() })
        .where(eq(userRestrictions.id, restrictionId));
      await writeAudit(tx, {
        actorId: admin.userId,
        action: "restriction.lift",
        targetType: "user",
        targetId: row.userId,
        before: { restrictionId, kind: row.kind, endsAt: row.endsAt },
        after: { reason: trimmed, via: admin.via },
        ip: admin.ip,
      });
      enqueued.push(
        await enqueueEventInTx(
          tx,
          "restriction.changed",
          {
            userId: row.userId,
            kind: row.kind,
            action: "lifted",
            operatorId: admin.userId,
            reason: trimmed,
          },
          { actorId: admin.userId, source: "admin" },
        ),
      );
      return null;
    }, POINTS_TX_OPTIONS),
  );
  if (failure) return failure;
  await dispatchOutboxRows(enqueued);
  await sweepPending();
  return { ok: true };
}

/** 用户搜索（用户名包含，仅 active，限 20）——保留给 UserPicker 等轻量场景 */
export async function searchUsers(query: string): Promise<
  {
    id: number;
    username: string;
    createdAt: string;
    threadCount: number | null;
    postCount: number | null;
  }[]
> {
  const q = query.trim();
  if (!q) return [];
  return getWebDb()
    .select({
      id: users.id,
      username: users.username,
      createdAt: users.createdAt,
      // 子查询里必须用字面量限定名 users.id：模板插值 ${users.id} 在单表查询会被渲染成
      // 裸 `id`，进入子查询作用域后解析到内层表的同名列（M9.5 发现的存量潜伏错误）
      threadCount: sql<
        number | null
      >`(SELECT COUNT(*) FROM threads WHERE threads.author_id = users.id AND threads.state = 'visible')`,
      postCount: sql<
        number | null
      >`(SELECT COUNT(*) FROM posts WHERE posts.author_id = users.id AND posts.state = 'visible')`,
    })
    .from(users)
    .where(and(eq(users.state, "active"), sql`${users.username} LIKE ${`%${q}%`}`))
    .orderBy(users.id)
    .limit(20);
}

export type AdminUserListFilters = {
  /** 纯数字 = uid 等值；否则用户名包含 */
  q?: string;
  /** restricted = 存在未过期的生效限制；all/空 = 不过滤 */
  status?: "all" | "restricted";
  sort: "recent" | "id" | "threads";
};

export const ADMIN_USERS_PER_PAGE = 20;

/**
 * 用户管理列表（M9.5 站长拍板：默认列最近注册，不再默认空页）。
 * 计数走两个聚合子查询（与 searchUsers 同口径，visible 状态）；受限筛选走 EXISTS 生效限制行。
 */
export async function listAdminUsersPage(
  filters: AdminUserListFilters,
  page: number,
): Promise<{
  items: {
    id: number;
    username: string;
    createdAt: string;
    threadCount: number | null;
    postCount: number | null;
    restricted: boolean;
  }[];
  total: number;
}> {
  const perPage = ADMIN_USERS_PER_PAGE;
  const q = filters.q?.trim() ?? "";
  const conditions = [sql`${users.state} = 'active'`];
  if (/^\d+$/.test(q)) {
    conditions.push(eq(users.id, Number(q)));
  } else if (q) {
    conditions.push(sql`${users.username} LIKE ${`%${q}%`}`);
  }
  if (filters.status === "restricted") {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM user_restrictions ur WHERE ur.user_id = ${users.id}
        AND ur.starts_at <= NOW() AND (ur.ends_at IS NULL OR ur.ends_at > NOW()))`,
    );
  }
  const where = and(...conditions);

  const orderBy =
    filters.sort === "id"
      ? [asc(users.id)]
      : filters.sort === "threads"
        ? [
            // 字面量限定名理由同 searchUsers（模板插值在单表查询渲染成裸列名）
            sql`(SELECT COUNT(*) FROM threads WHERE threads.author_id = users.id AND threads.state = 'visible') DESC`,
            desc(users.id),
          ]
        : [desc(users.id)];

  const [countRow, items] = await Promise.all([
    getWebDb()
      .select({ total: sql<number>`COUNT(*)` })
      .from(users)
      .where(where),
    getWebDb()
      .select({
        id: users.id,
        username: users.username,
        createdAt: users.createdAt,
        threadCount: sql<
          number | null
        >`(SELECT COUNT(*) FROM threads WHERE threads.author_id = users.id AND threads.state = 'visible')`,
        postCount: sql<
          number | null
        >`(SELECT COUNT(*) FROM posts WHERE posts.author_id = users.id AND posts.state = 'visible')`,
        // EXISTS 回来是 0/1，mapWith 转真布尔（drizzle 的 sql<boolean> 只标注不转换）
        restricted:
          sql<boolean>`EXISTS (SELECT 1 FROM user_restrictions ur WHERE ur.user_id = users.id
          AND ur.starts_at <= NOW() AND (ur.ends_at IS NULL OR ur.ends_at > NOW()))`.mapWith(
            Boolean,
          ),
      })
      .from(users)
      .where(where)
      .orderBy(...orderBy)
      .limit(perPage)
      .offset((page - 1) * perPage),
  ]);
  return { items, total: Number(countRow[0]?.total ?? 0) };
}

/** 用户管理详情聚合 */
export async function adminUserDetail(userId: number): Promise<{
  id: number;
  username: string;
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  points: number | null;
  roles: { roleKey: string; scopeId: number; expiresAt: string | null }[];
  restrictions: {
    id: number;
    kind: string;
    scopeId: number;
    reason: string;
    startsAt: string;
    endsAt: string | null;
    /** 服务端 NOW() 口径的生效布尔（替代页面侧 UTC 字符串比较，M9.5） */
    active: boolean;
  }[];
  sessions: { createdAt: string; ip: string | null; lastSeenAt: string | null }[];
} | null> {
  const [user] = await getWebDb()
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      points: pointAccounts.balance,
    })
    .from(users)
    .leftJoin(pointAccounts, eq(pointAccounts.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  const [roles, restrictions, sessionRows] = await Promise.all([
    getWebDb()
      .select({
        roleKey: userRoles.roleKey,
        scopeId: userRoles.scopeId,
        expiresAt: userRoles.expiresAt,
      })
      .from(userRoles)
      .where(eq(userRoles.userId, userId)),
    getWebDb()
      .select({
        id: userRestrictions.id,
        kind: userRestrictions.kind,
        scopeId: userRestrictions.scopeId,
        reason: userRestrictions.reason,
        startsAt: userRestrictions.startsAt,
        endsAt: userRestrictions.endsAt,
        active:
          sql<boolean>`(${userRestrictions.endsAt} IS NULL OR ${userRestrictions.endsAt} > NOW())`.mapWith(
            Boolean,
          ),
      })
      .from(userRestrictions)
      .where(eq(userRestrictions.userId, userId))
      .orderBy(desc(userRestrictions.id)),
    getWebDb()
      .select({ createdAt: sessions.createdAt, ip: sessions.ip, lastSeenAt: sessions.lastSeenAt })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.lastSeenAt))
      .limit(5),
  ]);

  return {
    ...user,
    roles,
    restrictions,
    sessions: sessionRows,
  };
}
