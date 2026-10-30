import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  auditLog,
  forums,
  getWebDb,
  pointAccounts,
  sessions,
  userRestrictions,
  userRoles,
  users,
} from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { nowBeijingWallTime, parseDbDateTime } from "@/lib/datetime";
import { restrictionActive } from "@/lib/authz/restrictions";
import { listUserAppeals } from "@/lib/authz/appeals";
import {
  hasOtherEffectiveSiteAdmin,
  isEffectiveSiteAdmin,
  lockSiteAdminInvariant,
} from "@/lib/authz/site-admin-invariant";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { publicUserDeleted } from "@/lib/queries/public-identity";
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

export type RestrictionKind = "ban" | "forum_ban" | "mute" | "no_avatar" | "no_signature";

export type RestrictionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "not_found"
        | "bad_kind"
        | "reason_required"
        | "reason_too_long"
        | "already"
        | "bad_scope"
        | "bad_ends_at"
        | "bad_state"
        | "last_admin";
    };

const KINDS: readonly RestrictionKind[] = ["ban", "forum_ban", "mute", "no_avatar", "no_signature"];

function isFutureBeijingDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const wall = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  if (
    wall.getUTCFullYear() !== year ||
    wall.getUTCMonth() !== month! - 1 ||
    wall.getUTCDate() !== day ||
    wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute ||
    wall.getUTCSeconds() !== second
  ) {
    return false;
  }
  const instant = parseDbDateTime(value).getTime();
  return Number.isFinite(instant) && instant > Date.now();
}

/** 创建限制并在同一事务内记录审计/通知；ban 同时吊销全部设备 session。 */
export async function createRestriction(
  admin: ConfigActor & { userId: number },
  input: { userId: number; kind: string; reason: string; endsAt: string | null; scopeId?: number },
): Promise<RestrictionResult> {
  if (!KINDS.includes(input.kind as RestrictionKind)) return { ok: false, code: "bad_kind" };
  const kind = input.kind as RestrictionKind;
  const reason = input.reason.trim();
  if (!reason) return { ok: false, code: "reason_required" };
  if (reason.length > 255) return { ok: false, code: "reason_too_long" };
  const scopeId = input.scopeId ?? 0;
  if (!Number.isInteger(scopeId) || scopeId < 0) return { ok: false, code: "bad_scope" };
  if (
    ((kind === "ban" || kind === "no_avatar" || kind === "no_signature") && scopeId !== 0) ||
    (kind === "forum_ban" && scopeId === 0)
  ) {
    return { ok: false, code: "bad_scope" };
  }
  const rawEndsAt = input.endsAt?.trim() ?? "";
  const endsAt = rawEndsAt === "" ? null : rawEndsAt;
  if (endsAt !== null && !isFutureBeijingDateTime(endsAt)) {
    return { ok: false, code: "bad_ends_at" };
  }

  const enqueued: EnqueuedEvent[] = [];
  const failure = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<RestrictionResult | null> => {
      const globalBan = kind === "ban" && scopeId === 0;
      if (globalBan) await lockSiteAdminInvariant(tx);

      const [user] = await tx
        .select({ id: users.id, state: users.state })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for("update");
      if (!user) return { ok: false, code: "not_found" };
      if (user.state !== "active") return { ok: false, code: "bad_state" };

      const [closure] = await tx
        .select({ id: accountDeletionRequests.id })
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.userId, input.userId),
            inArray(accountDeletionRequests.status, ["pending", "completed"]),
          ),
        )
        .limit(1);
      if (closure) return { ok: false, code: "bad_state" };

      if (scopeId > 0) {
        const [scope] = await tx
          .select({ id: forums.id })
          .from(forums)
          .where(eq(forums.id, scopeId))
          .limit(1);
        if (!scope) return { ok: false, code: "bad_scope" };
      }

      const [active] = await tx
        .select({ id: userRestrictions.id })
        .from(userRestrictions)
        .where(
          and(
            eq(userRestrictions.userId, input.userId),
            eq(userRestrictions.kind, kind),
            eq(userRestrictions.scopeId, scopeId),
            restrictionActive,
          ),
        )
        .limit(1);
      if (active) {
        if (globalBan) await tx.delete(sessions).where(eq(sessions.userId, input.userId));
        return { ok: false, code: "already" };
      }

      if (
        globalBan &&
        (await isEffectiveSiteAdmin(tx, input.userId)) &&
        !(await hasOtherEffectiveSiteAdmin(tx, input.userId))
      ) {
        return { ok: false, code: "last_admin" };
      }

      const now = nowBeijingWallTime();
      await tx.insert(userRestrictions).values({
        userId: input.userId,
        kind,
        scopeId,
        reason,
        startsAt: now,
        endsAt,
        createdBy: admin.userId,
        createdAt: now,
      });
      if (globalBan) await tx.delete(sessions).where(eq(sessions.userId, input.userId));
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
  lifecycle?: "active" | "closure_pending" | "deleted" | "all";
  credential?: "all" | "email_unverified" | "no_password" | "legacy_password_pending";
  sort: "recent" | "id" | "threads";
};

export const ADMIN_USERS_PER_PAGE = 20;

/** 用户治理列表：按生命周期、凭据状态与生效限制筛选，计数只聚合公开内容。 */
export async function listAdminUsersPage(
  filters: AdminUserListFilters,
  page: number,
): Promise<{
  items: {
    id: number;
    username: string;
    state: "active" | "deleted";
    closurePending: boolean;
    closureScheduledAt: string | null;
    emailVerified: boolean;
    emailVerificationRequired: boolean;
    hasPassword: boolean;
    legacyPasswordPending: boolean;
    createdAt: string;
    threadCount: number | null;
    postCount: number | null;
    restricted: boolean;
  }[];
  total: number;
}> {
  const perPage = ADMIN_USERS_PER_PAGE;
  const q = filters.q?.trim() ?? "";
  const conditions = [];
  const lifecycle = filters.lifecycle ?? "active";
  if (lifecycle === "active") {
    conditions.push(
      eq(users.state, "active"),
      sql`NOT EXISTS (SELECT 1 FROM account_deletion_requests adr WHERE adr.user_id = ${users.id}
        AND adr.status IN ('pending', 'completed'))`,
    );
  } else if (lifecycle === "closure_pending") {
    conditions.push(
      eq(users.state, "active"),
      sql`EXISTS (SELECT 1 FROM account_deletion_requests adr WHERE adr.user_id = ${users.id}
        AND adr.status = 'pending')`,
    );
  } else if (lifecycle === "deleted") {
    conditions.push(
      sql`(${users.state} = 'deleted' OR EXISTS (SELECT 1 FROM account_deletion_requests adr
        WHERE adr.user_id = ${users.id} AND adr.status = 'completed'))`,
    );
  }
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
  if (filters.credential === "email_unverified") {
    conditions.push(
      and(
        sql`NOT ${publicUserDeleted(users.id, users.state)}`,
        eq(users.emailVerificationRequired, true),
        sql`${users.emailVerifiedAt} IS NULL`,
      )!,
    );
  } else if (filters.credential === "no_password") {
    conditions.push(
      and(
        sql`NOT ${publicUserDeleted(users.id, users.state)}`,
        sql`${users.passwordHash} IS NULL`,
      )!,
    );
  } else if (filters.credential === "legacy_password_pending") {
    conditions.push(
      and(
        sql`NOT ${publicUserDeleted(users.id, users.state)}`,
        eq(users.legacyPasswordPending, true),
      )!,
    );
  }
  const where = and(...conditions);

  const orderBy =
    filters.sort === "id"
      ? [asc(users.id)]
      : filters.sort === "threads"
        ? [
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
        username: sql<string>`CASE WHEN ${publicUserDeleted(users.id, users.state)} THEN '已注销用户' ELSE ${users.username} END`,
        state: sql<
          "active" | "deleted"
        >`CASE WHEN ${publicUserDeleted(users.id, users.state)} THEN 'deleted' ELSE 'active' END`,
        emailVerified: sql<boolean>`${users.emailVerifiedAt} IS NOT NULL`.mapWith(Boolean),
        emailVerificationRequired: users.emailVerificationRequired,
        hasPassword: sql<boolean>`${users.passwordHash} IS NOT NULL`.mapWith(Boolean),
        legacyPasswordPending: users.legacyPasswordPending,
        createdAt: users.createdAt,
        threadCount: sql<number | null>`(SELECT COUNT(*) FROM threads
          WHERE threads.author_id = users.id AND threads.state = 'visible')`,
        postCount: sql<number | null>`(SELECT COUNT(*) FROM posts
          WHERE posts.author_id = users.id AND posts.state = 'visible')`,
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
  const closureRows = items.length
    ? await getWebDb()
        .select({
          userId: accountDeletionRequests.userId,
          scheduledAt: accountDeletionRequests.scheduledAt,
        })
        .from(accountDeletionRequests)
        .where(
          and(
            inArray(
              accountDeletionRequests.userId,
              items.map((row) => row.id),
            ),
            eq(accountDeletionRequests.status, "pending"),
          ),
        )
        .orderBy(desc(accountDeletionRequests.id))
    : [];
  const closureByUser = new Map<number, string>();
  for (const closure of closureRows) {
    if (!closureByUser.has(closure.userId)) closureByUser.set(closure.userId, closure.scheduledAt);
  }

  return {
    items: items.map((row) => {
      const closureScheduledAt = closureByUser.get(row.id) ?? null;
      const deleted = row.state === "deleted";
      return {
        ...row,
        emailVerified: deleted ? false : row.emailVerified,
        emailVerificationRequired: deleted ? false : row.emailVerificationRequired,
        hasPassword: deleted ? false : row.hasPassword,
        legacyPasswordPending: deleted ? false : row.legacyPasswordPending,
        restricted: deleted ? false : row.restricted,
        closurePending: closureScheduledAt !== null,
        closureScheduledAt,
      };
    }),
    total: Number(countRow[0]?.total ?? 0),
  };
}

/** 后台吊销指定用户的一台 session；要求查询后仍校验 session 属于该用户。 */
export async function revokeUserSessionByAdmin(
  admin: ConfigActor & { userId: number },
  userId: number,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; code: "not_found" | "session_not_found" }> {
  return getWebDb().transaction(async (tx) => {
    const [session] = await tx
      .select({ createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .limit(1)
      .for("update");
    if (!session) return { ok: false, code: "session_not_found" };
    await tx.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
    await writeAudit(tx, {
      actorId: admin.userId,
      action: "session.revoke",
      targetType: "user",
      targetId: userId,
      before: { sessionIdPrefix: sessionId.slice(0, 12), createdAt: session.createdAt },
      after: { revoked: true },
      ip: admin.ip,
    });
    return { ok: true };
  });
}

/** 用户管理详情聚合 */
export async function adminUserDetail(
  userId: number,
  includeIp = false,
): Promise<{
  id: number;
  username: string;
  state: "active" | "deleted";
  email: string | null;
  emailVerifiedAt: string | null;
  emailVerificationRequired: boolean;
  hasPassword: boolean;
  legacyPasswordPending: boolean;
  closureRequest: {
    status: "pending" | "cancelled" | "completed";
    requestedAt: string;
    scheduledAt: string;
  } | null;
  createdAt: string;
  lastLoginAt: string | null;
  points: number | null;
  roles: {
    roleKey: string;
    scopeId: number;
    expiresAt: string | null;
    grantedAt: string;
    grantedBy: number | null;
    active: boolean;
  }[];
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
  sessions: {
    id: string;
    createdAt: string;
    expiresAt: string;
    ip: string | null;
    lastSeenAt: string | null;
    active: boolean;
  }[];
  audit: {
    id: number;
    action: string;
    actorId: number | null;
    createdAt: string;
    beforeJson: unknown;
    afterJson: unknown;
  }[];
  appeals: {
    id: number;
    targetType: "restriction" | "account_deletion";
    targetId: number;
    reason: string;
    status: "pending" | "approved" | "rejected";
    handledBy: number | null;
    handledAt: string | null;
    result: string | null;
    createdAt: string;
  }[];
} | null> {
  const [user] = await getWebDb()
    .select({
      id: users.id,
      username: sql<string>`CASE WHEN ${publicUserDeleted(users.id, users.state)} THEN '已注销用户' ELSE ${users.username} END`,
      state: sql<
        "active" | "deleted"
      >`CASE WHEN ${publicUserDeleted(users.id, users.state)} THEN 'deleted' ELSE 'active' END`,
      email: sql<
        string | null
      >`CASE WHEN ${publicUserDeleted(users.id, users.state)} THEN NULL ELSE ${users.email} END`,
      emailVerifiedAt: sql<
        string | null
      >`CASE WHEN ${publicUserDeleted(users.id, users.state)} THEN NULL ELSE ${users.emailVerifiedAt} END`,
      emailVerificationRequired:
        sql<boolean>`(${users.emailVerificationRequired} AND NOT ${publicUserDeleted(users.id, users.state)})`.mapWith(
          Boolean,
        ),
      hasPassword:
        sql<boolean>`(${users.passwordHash} IS NOT NULL AND NOT ${publicUserDeleted(users.id, users.state)})`.mapWith(
          Boolean,
        ),
      legacyPasswordPending:
        sql<boolean>`(${users.legacyPasswordPending} AND NOT ${publicUserDeleted(users.id, users.state)})`.mapWith(
          Boolean,
        ),
      createdAt: users.createdAt,
      lastLoginAt: sql<
        string | null
      >`CASE WHEN ${publicUserDeleted(users.id, users.state)} THEN NULL ELSE ${users.lastLoginAt} END`,
      points: sql<
        number | null
      >`CASE WHEN ${publicUserDeleted(users.id, users.state)} THEN NULL ELSE ${pointAccounts.balance} END`,
    })
    .from(users)
    .leftJoin(pointAccounts, eq(pointAccounts.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  const [roles, restrictions, sessionRows, closureRows, auditRows, appealRows] = await Promise.all([
    getWebDb()
      .select({
        roleKey: userRoles.roleKey,
        scopeId: userRoles.scopeId,
        expiresAt: userRoles.expiresAt,
        grantedAt: userRoles.grantedAt,
        grantedBy: userRoles.grantedBy,
        active:
          sql<boolean>`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > NOW())`.mapWith(
            Boolean,
          ),
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
        active: restrictionActive.mapWith(Boolean),
      })
      .from(userRestrictions)
      .where(eq(userRestrictions.userId, userId))
      .orderBy(desc(userRestrictions.id)),
    getWebDb()
      .select({
        id: sessions.id,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        ip: includeIp ? sessions.ip : sql<string | null>`NULL`,
        lastSeenAt: sessions.lastSeenAt,
        active: sql<boolean>`${sessions.expiresAt} > NOW()`.mapWith(Boolean),
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.lastSeenAt))
      .limit(5),
    getWebDb()
      .select({
        status: accountDeletionRequests.status,
        requestedAt: accountDeletionRequests.requestedAt,
        scheduledAt: accountDeletionRequests.scheduledAt,
      })
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.userId, userId))
      .orderBy(desc(accountDeletionRequests.id))
      .limit(1),
    getWebDb()
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actorId: auditLog.actorId,
        createdAt: auditLog.createdAt,
        beforeJson: auditLog.beforeJson,
        afterJson: auditLog.afterJson,
      })
      .from(auditLog)
      .where(and(eq(auditLog.targetType, "user"), eq(auditLog.targetId, String(userId))))
      .orderBy(desc(auditLog.id))
      .limit(20),
    listUserAppeals(userId),
  ]);

  return {
    ...user,
    closureRequest: closureRows[0] ?? null,
    roles,
    restrictions,
    sessions: sessionRows,
    audit: auditRows,
    appeals: appealRows,
  };
}
