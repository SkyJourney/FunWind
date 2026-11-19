import "server-only";

import { and, eq } from "drizzle-orm";
import { forums, getWebDb, sessions, userRestrictions } from "@funwind/db";
import type { ConfigActor, DbTx } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { isFutureBeijingDateTime, nowBeijingWallTime } from "@/lib/datetime";
import { lockActiveUserInTx } from "@/lib/identity";
import { restrictionActive } from "@/lib/authz/restrictions";
import { revokeAdminApiTokensIfNotSiteAdmin } from "@/lib/manage/tokens";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";
import {
  hasOtherEffectiveSiteAdmin,
  isEffectiveSiteAdmin,
  lockSiteAdminInvariant,
} from "@/lib/authz/site-admin-invariant";
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

/** 失败码的非空子集：创建/解除共用的可拒绝码（含 not_found 与输入类）。 */
type RestrictionFailureCode = Exclude<RestrictionResult, { ok: true }>["code"];
type RestrictionDenial = ModerationWriteDenial<RestrictionFailureCode>;

/** 创建限制的校验后计划：kind/scope/endsAt 合法性已核验，进入锁段。 */
type RestrictionCreatePlan = {
  userId: number;
  kind: RestrictionKind;
  scopeId: number;
  reason: string;
  endsAt: string | null;
};

/** 输入校验（后台与 REST 共享，事务外）：kind 五类、理由非空、scope 与 kind 配对、endsAt 为未来。 */
function planCreateRestriction(input: {
  userId: number;
  kind: string;
  reason: string;
  endsAt: string | null;
  scopeId?: number;
}): { ok: true; plan: RestrictionCreatePlan } | RestrictionDenial {
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
  return { ok: true, plan: { userId: input.userId, kind, scopeId, reason, endsAt } };
}

/** 锁段（后台与 REST 共享）：全局封禁先锁站点管理员不变量，再锁目标用户；不做可变状态裁决。 */
async function lockCreateTarget(
  tx: DbTx,
  plan: RestrictionCreatePlan,
): Promise<{ ok: true } | RestrictionDenial> {
  const globalBan = plan.kind === "ban" && plan.scopeId === 0;
  if (globalBan) await lockSiteAdminInvariant(tx);
  const target = await lockActiveUserInTx(tx, plan.userId);
  if (!target.ok) {
    return { ok: false, code: target.code === "not_found" ? "not_found" : "bad_state" };
  }
  return { ok: true };
}

/** 执行段（后台与 REST 共享）：already/last_admin 状态裁决 + 写入 + 封禁联动 + 审计 + 事件。 */
async function applyRestrictionCreate(
  tx: DbTx,
  admin: ConfigActor & { userId: number },
  plan: RestrictionCreatePlan,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; event: EnqueuedEvent } | RestrictionDenial> {
  const { userId, kind, scopeId, reason, endsAt } = plan;
  const globalBan = kind === "ban" && scopeId === 0;
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
        eq(userRestrictions.userId, userId),
        eq(userRestrictions.kind, kind),
        eq(userRestrictions.scopeId, scopeId),
        restrictionActive,
      ),
    )
    .limit(1);
  if (active) {
    if (globalBan) {
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      // M20 撤权联动：重复封禁同样保持「封禁 ⇔ token 失效」（此前解封后可能重签过 token）
      await revokeAdminApiTokensIfNotSiteAdmin(tx, userId, {
        actorId: admin.userId,
        via: admin.via,
      });
    }
    return { ok: false, code: "already" };
  }

  if (
    globalBan &&
    (await isEffectiveSiteAdmin(tx, userId)) &&
    !(await hasOtherEffectiveSiteAdmin(tx, userId))
  ) {
    return { ok: false, code: "last_admin" };
  }

  const now = nowBeijingWallTime();
  await tx.insert(userRestrictions).values({
    userId,
    kind,
    scopeId,
    reason,
    startsAt: now,
    endsAt,
    createdBy: admin.userId,
    createdAt: now,
  });
  if (globalBan) {
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    // M20 撤权联动：全站封禁使持有人失去管理员资格，同事务吊销全部 Access Token
    await revokeAdminApiTokensIfNotSiteAdmin(tx, userId, {
      actorId: admin.userId,
      via: admin.via,
    });
  }
  await writeAudit(tx, {
    actorId: admin.userId,
    action: "restriction.create",
    targetType: "user",
    targetId: userId,
    after: {
      kind,
      scopeId,
      reason,
      endsAt,
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
  const event = await enqueueEventInTx(
    tx,
    "restriction.changed",
    { userId, kind, action: "created", operatorId: admin.userId, reason, endsAt },
    { actorId: admin.userId, source: "admin" },
  );
  return { ok: true, event };
}

/** 创建限制并在同一事务内记录审计/通知；ban 同时吊销全部设备 session。 */
export async function createRestriction(
  admin: ConfigActor & { userId: number },
  input: { userId: number; kind: string; reason: string; endsAt: string | null; scopeId?: number },
): Promise<RestrictionResult> {
  const planned = planCreateRestriction(input);
  if (!planned.ok) return planned;

  const enqueued: EnqueuedEvent[] = [];
  const failure = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<RestrictionResult | null> => {
      const locked = await lockCreateTarget(tx, planned.plan);
      if (!locked.ok) return locked;
      const applied = await applyRestrictionCreate(tx, admin, planned.plan);
      if (!applied.ok) return applied;
      enqueued.push(applied.event);
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
      const locked = await lockLiftTarget(tx, restrictionId, null);
      if (!locked.ok) return locked;
      const applied = await applyRestrictionLift(tx, admin, locked.row, trimmed);
      if (!applied.ok) return applied;
      enqueued.push(applied.event);
      return null;
    }, POINTS_TX_OPTIONS),
  );
  if (failure) return failure;
  await dispatchOutboxRows(enqueued);
  await sweepPending();
  return { ok: true };
}

export {
  ADMIN_USERS_PER_PAGE,
  adminUserDetail,
  listAdminUsersPage,
  searchUsers,
  type AdminUserListFilters,
} from "./admin-user-views";

/** 后台吊销指定用户的一台 session；要求查询后仍校验 session 属于该用户。 */
export async function revokeUserSessionByAdmin(
  admin: ConfigActor & { userId: number },
  userId: number,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; code: "not_found" | "session_not_found" }> {
  return getWebDb().transaction(async (tx) => {
    const locked = await lockSessionTarget(tx, userId, sessionId);
    if (!locked.ok) return locked;
    await applySessionRevoke(tx, admin, userId, sessionId, locked.row);
    return { ok: true };
  });
}

/** 解除限制的行锁产物（id + 展示字段，供审计与事件载荷复用）。 */
type LockedLiftRow = {
  id: number;
  userId: number;
  kind: RestrictionKind;
  endsAt: string | null;
};

/** 锁段（后台与 REST 共享）：按 id 行锁取限制行；expectedUserId 非空时校验归属（越权与不存在同型 404）。 */
async function lockLiftTarget(
  tx: DbTx,
  restrictionId: number,
  expectedUserId: number | null,
): Promise<{ ok: true; row: LockedLiftRow } | RestrictionDenial> {
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
  if (!row || (expectedUserId !== null && row.userId !== expectedUserId)) {
    return { ok: false, code: "not_found" };
  }
  return { ok: true, row };
}

/** 执行段（后台与 REST 共享）：过期行 already（裁决在执行段，回放命中缓存时不做此判断）。 */
async function applyRestrictionLift(
  tx: DbTx,
  admin: ConfigActor & { userId: number },
  row: LockedLiftRow,
  note: string,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; event: EnqueuedEvent } | RestrictionDenial> {
  if (row.endsAt !== null && row.endsAt <= nowBeijingWallTime()) {
    return { ok: false, code: "already" };
  }
  await tx
    .update(userRestrictions)
    .set({ endsAt: nowBeijingWallTime() })
    .where(eq(userRestrictions.id, row.id));
  await writeAudit(tx, {
    actorId: admin.userId,
    action: "restriction.lift",
    targetType: "user",
    targetId: row.userId,
    before: { restrictionId: row.id, kind: row.kind, endsAt: row.endsAt },
    after: {
      reason: note,
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
  const event = await enqueueEventInTx(
    tx,
    "restriction.changed",
    {
      userId: row.userId,
      kind: row.kind,
      action: "lifted",
      operatorId: admin.userId,
      reason: note,
    },
    { actorId: admin.userId, source: "admin" },
  );
  return { ok: true, event };
}

/** 会话吊销的行锁产物（审计用的创建时间）。 */
type LockedSessionRow = { createdAt: string | null };

/** 会话吊销专属拒绝码（不涉限制类码；越权与不存在同型）。 */
type SessionRevokeDenial = ModerationWriteDenial<"not_found" | "session_not_found">;

/** 锁段（后台与 REST 共享）：行锁且查询即带归属条件（session id 与用户绑定）。 */
async function lockSessionTarget(
  tx: DbTx,
  userId: number,
  sessionId: string,
): Promise<{ ok: true; row: LockedSessionRow } | SessionRevokeDenial> {
  const [session] = await tx
    .select({ createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1)
    .for("update");
  if (!session) return { ok: false, code: "session_not_found" };
  return { ok: true, row: { createdAt: session.createdAt } };
}

/** 执行段（后台与 REST 共享）：删行 + 审计（session id 只落前 12 位前缀）。 */
async function applySessionRevoke(
  tx: DbTx,
  admin: ConfigActor & { userId: number },
  userId: number,
  sessionId: string,
  row: LockedSessionRow,
  trace?: ModerationApiTrace,
): Promise<void> {
  await tx.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  await writeAudit(tx, {
    actorId: admin.userId,
    action: "session.revoke",
    targetType: "user",
    targetId: userId,
    before: { sessionIdPrefix: sessionId.slice(0, 12), createdAt: row.createdAt },
    after: {
      revoked: true,
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
}

// ============================================================
// REST 写变体（M20.3 Step 2）：prepare/lock/execute 三段式，供管理 REST 幂等
// 管线接入；与后台入口共享 lock/apply 内核，写入/审计/事件语义完全一致。
// 幂等契约：lock 段只做存在性与归属锁，可变状态裁决统一在 execute——
// 合法回放在进入本函数前已被幂等缓存短路，不会执行任何状态判断。
// ============================================================

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const RESTRICTIONS_DENIAL_HTTP = {
  not_found: "not_found",
  session_not_found: "not_found",
  bad_kind: "bad_request",
  reason_required: "bad_request",
  reason_too_long: "bad_request",
  bad_scope: "bad_request",
  bad_ends_at: "bad_request",
  already: "state_conflict",
  bad_state: "state_conflict",
  last_admin: "state_conflict",
} as const;

/** REST 三段式写变体的准备产物类型（data 为写响应载荷，denial 复用域拒绝码）。 */
export type PreparedApiRestriction = PreparedModerationWrite<
  {
    userId: number;
    kind: RestrictionKind;
    scopeId: number;
    endsAt: string | null;
  },
  RestrictionFailureCode
>;
export type PreparedApiLift = PreparedModerationWrite<
  { restrictionId: number; userId: number; kind: RestrictionKind },
  RestrictionFailureCode
>;
export type PreparedApiSessionRevoke = PreparedModerationWrite<
  { sessionId: string; userId: number; revoked: boolean },
  "not_found" | "session_not_found"
>;

/** REST 创建限制：入参校验在 prepare（事务外），锁段/执行段与后台共享内核。 */
export async function prepareApiRestriction(
  admin: ConfigActor & { userId: number },
  input: { userId: number; kind: string; reason: string; endsAt: string | null; scopeId?: number },
  trace?: ModerationApiTrace,
): Promise<PreparedApiRestriction | RestrictionDenial> {
  const planned = planCreateRestriction(input);
  if (!planned.ok) return planned;
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockCreateTarget(tx, planned.plan);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          const applied = await applyRestrictionCreate(tx, admin, planned.plan, trace);
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: {
              userId: planned.plan.userId,
              kind: planned.plan.kind,
              scopeId: planned.plan.scopeId,
              endsAt: planned.plan.endsAt,
            },
            async afterCommit() {
              await dispatchOutboxRows([applied.event]);
              await sweepPending();
            },
          };
        },
      };
    },
  };
}

/** REST 解除限制：expectedUserId 为路径语义的归属校验（越权与不存在同型 404）。 */
export async function prepareApiRestrictionLift(
  admin: ConfigActor & { userId: number },
  expectedUserId: number,
  restrictionId: number,
  note: string,
  trace?: ModerationApiTrace,
): Promise<PreparedApiLift | RestrictionDenial> {
  const trimmed = note.trim();
  if (!trimmed) return { ok: false, code: "reason_required" };
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockLiftTarget(tx, restrictionId, expectedUserId);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          const applied = await applyRestrictionLift(tx, admin, locked.row, trimmed, trace);
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: { restrictionId, userId: locked.row.userId, kind: locked.row.kind },
            async afterCommit() {
              await dispatchOutboxRows([applied.event]);
              await sweepPending();
            },
          };
        },
      };
    },
  };
}

/** REST 吊销会话：归属与存在性在锁段（合法回放已被缓存短路，不会走到这里）。 */
export async function prepareApiSessionRevoke(
  admin: ConfigActor & { userId: number },
  userId: number,
  sessionId: string,
  trace?: ModerationApiTrace,
): Promise<PreparedApiSessionRevoke | RestrictionDenial> {
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockSessionTarget(tx, userId, sessionId);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          await applySessionRevoke(tx, admin, userId, sessionId, locked.row, trace);
          return { ok: true, data: { sessionId, userId, revoked: true } };
        },
      };
    },
  };
}
