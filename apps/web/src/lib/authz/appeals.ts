import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  getWebDb,
  insertIdOf,
  userAppeals,
  userRestrictions,
  users,
} from "@funwind/db";
import { writeAudit, type ConfigActor } from "@/lib/audit";
import { restrictionActive } from "@/lib/authz/restrictions";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";
import { type PasswordVerifier, verifyAccountPassword } from "@/lib/auth/password";
import { publicUserDeleted, publicUsername } from "@/lib/identity-expr";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";

export class AppealError extends Error {
  constructor(
    readonly code:
      | "invalid_credentials"
      | "no_active_restrictions"
      | "already_pending"
      | "not_found"
      | "already_handled"
      | "result_required",
  ) {
    super(code);
    this.name = "AppealError";
  }
}

export type AppealSubmission = { submitted: number };

async function createAppealsInTx(
  tx: Parameters<Parameters<ReturnType<typeof getWebDb>["transaction"]>[0]>[0],
  userId: number,
  reason: string,
  ip: string | null,
): Promise<{ submitted: number; events: EnqueuedEvent[] }> {
  const restrictions = await tx
    .select({ id: userRestrictions.id })
    .from(userRestrictions)
    .where(and(eq(userRestrictions.userId, userId), restrictionActive))
    .orderBy(desc(userRestrictions.id))
    .for("update");
  if (restrictions.length === 0) throw new AppealError("no_active_restrictions");

  let submitted = 0;
  const events: EnqueuedEvent[] = [];
  for (const restriction of restrictions) {
    const [pending] = await tx
      .select({ id: userAppeals.id })
      .from(userAppeals)
      .where(
        and(
          eq(userAppeals.userId, userId),
          eq(userAppeals.targetType, "restriction"),
          eq(userAppeals.targetId, restriction.id),
          eq(userAppeals.status, "pending"),
        ),
      )
      .limit(1)
      .for("update");
    if (pending) continue;

    const appealId = insertIdOf(
      await tx.insert(userAppeals).values({
        userId,
        targetType: "restriction",
        targetId: restriction.id,
        reason,
        status: "pending",
        createdAt: sql`NOW()`,
      }),
    );
    await writeAudit(tx, {
      actorId: userId,
      action: "user.appeal.submit",
      targetType: "user_appeal",
      targetId: appealId,
      after: { targetType: "restriction", targetId: restriction.id },
      ip,
    });
    events.push(
      await enqueueEventInTx(
        tx,
        "account.appeal.submitted",
        { userId, appealId, targetType: "restriction", targetId: restriction.id },
        { actorId: userId, source: "user-appeals" },
      ),
    );
    submitted += 1;
  }
  if (submitted === 0) throw new AppealError("already_pending");
  return { submitted, events };
}

export async function submitAppealAsUser(
  userId: number,
  reason: string,
  ip: string | null,
): Promise<AppealSubmission> {
  const trimmed = reason.trim();
  if (!trimmed) throw new AppealError("result_required");
  const events: EnqueuedEvent[] = [];
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const [user] = await tx
        .select({ state: users.state })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!user || user.state !== "active") throw new AppealError("invalid_credentials");
      const [closure] = await tx
        .select({ id: accountDeletionRequests.id })
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.userId, userId),
            eq(accountDeletionRequests.status, "pending"),
          ),
        )
        .limit(1);
      if (closure) throw new AppealError("invalid_credentials");
      const created = await createAppealsInTx(tx, userId, trimmed, ip);
      events.push(...created.events);
      return { submitted: created.submitted };
    }, POINTS_TX_OPTIONS),
  );
  await dispatchOutboxRows(events);
  await sweepPending();
  return result;
}

export async function submitAppealWithPassword(
  identifier: string,
  password: string,
  reason: string,
  ip: string | null,
  deps: { verify?: PasswordVerifier } = {},
): Promise<AppealSubmission> {
  const key = identifier.trim().toLowerCase();
  const trimmed = reason.trim();
  if (!key || !password) {
    await verifyAccountPassword(null, password, deps.verify);
    throw new AppealError("invalid_credentials");
  }
  if (!trimmed) throw new AppealError("result_required");
  const [candidate] = await getWebDb()
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(sql`(${users.usernameKey} = ${key} OR ${users.emailKey} = ${key})`)
    .limit(1);
  const passwordOk = await verifyAccountPassword(
    candidate?.passwordHash ?? null,
    password,
    deps.verify,
  );
  if (!candidate || !passwordOk) {
    throw new AppealError("invalid_credentials");
  }

  const events: EnqueuedEvent[] = [];
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const [user] = await tx
        .select({ state: users.state, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, candidate.id))
        .limit(1)
        .for("update");
      if (!user || user.state !== "active" || user.passwordHash !== candidate.passwordHash) {
        throw new AppealError("invalid_credentials");
      }
      const [closure] = await tx
        .select({ id: accountDeletionRequests.id })
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.userId, candidate.id),
            eq(accountDeletionRequests.status, "pending"),
          ),
        )
        .limit(1);
      if (closure) throw new AppealError("invalid_credentials");
      const created = await createAppealsInTx(tx, candidate.id, trimmed, ip);
      events.push(...created.events);
      return { submitted: created.submitted };
    }, POINTS_TX_OPTIONS),
  );
  await dispatchOutboxRows(events);
  await sweepPending();
  return result;
}

export async function listUserAppeals(userId: number) {
  return getWebDb()
    .select({
      id: userAppeals.id,
      targetType: userAppeals.targetType,
      targetId: userAppeals.targetId,
      reason: userAppeals.reason,
      status: userAppeals.status,
      handledBy: userAppeals.handledBy,
      handledAt: userAppeals.handledAt,
      result: userAppeals.result,
      createdAt: userAppeals.createdAt,
    })
    .from(userAppeals)
    .where(eq(userAppeals.userId, userId))
    .orderBy(desc(userAppeals.createdAt), desc(userAppeals.id))
    .limit(50);
}

export async function listPendingUserAppeals(limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 50));
  return getWebDb()
    .select({
      id: userAppeals.id,
      userId: userAppeals.userId,
      username: publicUsername(users.username, users.state, users.id),
      targetType: userAppeals.targetType,
      targetId: userAppeals.targetId,
      reason: userAppeals.reason,
      status: userAppeals.status,
      createdAt: userAppeals.createdAt,
      userDeleted: publicUserDeleted(users.id, users.state).mapWith(Boolean),
    })
    .from(userAppeals)
    .leftJoin(users, eq(users.id, userAppeals.userId))
    .where(eq(userAppeals.status, "pending"))
    .orderBy(userAppeals.createdAt, userAppeals.id)
    .limit(safeLimit);
}

export async function resolveUserAppeal(
  admin: ConfigActor & { userId: number },
  appealId: number,
  status: "approved" | "rejected",
  result: string,
): Promise<void> {
  const trimmed = result.trim();
  if (!trimmed) throw new AppealError("result_required");
  if (trimmed.length > 1000) throw new AppealError("result_required");
  let event: EnqueuedEvent | null = null;
  await getWebDb().transaction(async (tx) => {
    const locked = await lockAppealTarget(tx, appealId, null);
    if (!locked.ok) throw new AppealError(locked.code);
    const applied = await applyAppealResolve(tx, admin, appealId, status, trimmed, locked.target);
    if (!applied.ok) throw new AppealError(applied.code);
    event = applied.event;
  });
  if (event) await dispatchOutboxRows([event]);
  await sweepPending();
}

// ============================================================
// REST 写变体（M20.3 Step 2）：prepare/lock/execute 三段式，与后台入口共享
// lock/apply 内核；pending 裁决统一在 execute，合法回放已被幂等缓存短路。
// ============================================================

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；仅处置侧码，提交侧码不在其中）。 */
export const APPEALS_DENIAL_HTTP = {
  not_found: "not_found",
  already_handled: "state_conflict",
  result_required: "bad_request",
} as const;

type AppealFailureCode = Extract<
  AppealError["code"],
  "not_found" | "already_handled" | "result_required"
>;
type AppealDenial = ModerationWriteDenial<AppealFailureCode>;

/** 处置的行锁产物（申诉归属用户与锁内状态快照）。 */
type LockedAppeal = { targetUserId: number; status: "pending" | "approved" | "rejected" };

/** 锁段（后台与 REST 共享）：锁申诉行取归属 → 锁用户行核验 active；expectedUserId 非空时校验归属。 */
async function lockAppealTarget(
  tx: Parameters<Parameters<ReturnType<typeof getWebDb>["transaction"]>[0]>[0],
  appealId: number,
  expectedUserId: number | null,
): Promise<{ ok: true; target: LockedAppeal } | AppealDenial> {
  const [appeal] = await tx
    .select({ userId: userAppeals.userId, status: userAppeals.status })
    .from(userAppeals)
    .where(eq(userAppeals.id, appealId))
    .limit(1)
    .for("update");
  if (!appeal || (expectedUserId !== null && appeal.userId !== expectedUserId)) {
    return { ok: false, code: "not_found" };
  }
  const [user] = await tx
    .select({ state: users.state })
    .from(users)
    .where(eq(users.id, appeal.userId))
    .limit(1)
    .for("update");
  if (!user || user.state !== "active") return { ok: false, code: "not_found" };
  return { ok: true, target: { targetUserId: appeal.userId, status: appeal.status } };
}

/** 执行段（后台与 REST 共享）：pending 裁决 + 写入 + 审计 + 事件。 */
async function applyAppealResolve(
  tx: Parameters<Parameters<ReturnType<typeof getWebDb>["transaction"]>[0]>[0],
  admin: ConfigActor & { userId: number },
  appealId: number,
  status: "approved" | "rejected",
  trimmed: string,
  target: LockedAppeal,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; event: EnqueuedEvent } | AppealDenial> {
  if (target.status !== "pending") return { ok: false, code: "already_handled" };
  await tx
    .update(userAppeals)
    .set({ status, handledBy: admin.userId, handledAt: sql`NOW()`, result: trimmed })
    .where(eq(userAppeals.id, appealId));
  await writeAudit(tx, {
    actorId: admin.userId,
    action: "user.appeal.resolve",
    targetType: "user_appeal",
    targetId: appealId,
    after: {
      status,
      targetUserId: target.targetUserId,
      via: admin.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: admin.ip,
  });
  const event = await enqueueEventInTx(
    tx,
    "account.appeal.resolved",
    { userId: target.targetUserId, appealId, status },
    { actorId: admin.userId, source: "user-appeals" },
  );
  return { ok: true, event };
}

/** REST 申诉处置的准备产物类型。 */
export type PreparedApiAppealResolve = PreparedModerationWrite<
  { appealId: number; status: "approved" | "rejected" },
  AppealFailureCode
>;

/** REST 申诉处置：入参校验在 prepare（事务外），锁段/执行段与后台共享内核。 */
export async function prepareApiAppealResolve(
  admin: ConfigActor & { userId: number },
  expectedUserId: number,
  appealId: number,
  status: "approved" | "rejected",
  result: string,
  trace?: ModerationApiTrace,
): Promise<PreparedApiAppealResolve | AppealDenial> {
  const trimmed = result.trim();
  if (!trimmed || trimmed.length > 1000) return { ok: false, code: "result_required" };
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockAppealTarget(tx, appealId, expectedUserId);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          const applied = await applyAppealResolve(
            tx,
            admin,
            appealId,
            status,
            trimmed,
            locked.target,
            trace,
          );
          if (!applied.ok) return applied;
          return {
            ok: true,
            data: { appealId, status },
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
