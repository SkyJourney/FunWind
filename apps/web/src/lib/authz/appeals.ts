import { and, desc, eq, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  getWebDb,
  userAppeals,
  userRestrictions,
  users,
} from "@funwind/db";
import { writeAudit, type ConfigActor } from "@/lib/audit";
import { restrictionActive } from "@/lib/authz/restrictions";
import { verifyPassword } from "@/lib/auth/password";
import { publicUserDeleted, publicUsername } from "@/lib/queries/public-identity";
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

    const [created] = (await tx.insert(userAppeals).values({
      userId,
      targetType: "restriction",
      targetId: restriction.id,
      reason,
      status: "pending",
      createdAt: sql`NOW()`,
    })) as unknown as [{ insertId: number }];
    const appealId = Number(created.insertId);
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
): Promise<AppealSubmission> {
  const key = identifier.trim().toLowerCase();
  const trimmed = reason.trim();
  if (!key || !password) throw new AppealError("invalid_credentials");
  if (!trimmed) throw new AppealError("result_required");
  const [candidate] = await getWebDb()
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(sql`(${users.usernameKey} = ${key} OR ${users.emailKey} = ${key})`)
    .limit(1);
  if (!candidate?.passwordHash || !(await verifyPassword(candidate.passwordHash, password))) {
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
  const [candidate] = await getWebDb()
    .select({ userId: userAppeals.userId })
    .from(userAppeals)
    .where(eq(userAppeals.id, appealId))
    .limit(1);
  if (!candidate) throw new AppealError("not_found");
  let event: EnqueuedEvent | null = null;
  await getWebDb().transaction(async (tx) => {
    const [user] = await tx
      .select({ state: users.state })
      .from(users)
      .where(eq(users.id, candidate.userId))
      .limit(1)
      .for("update");
    if (!user || user.state !== "active") throw new AppealError("not_found");
    const [appeal] = await tx
      .select({ userId: userAppeals.userId, status: userAppeals.status })
      .from(userAppeals)
      .where(eq(userAppeals.id, appealId))
      .limit(1)
      .for("update");
    if (!appeal || appeal.userId !== candidate.userId) throw new AppealError("not_found");
    if (appeal.status !== "pending") throw new AppealError("already_handled");
    await tx
      .update(userAppeals)
      .set({ status, handledBy: admin.userId, handledAt: sql`NOW()`, result: trimmed })
      .where(eq(userAppeals.id, appealId));
    await writeAudit(tx, {
      actorId: admin.userId,
      action: "user.appeal.resolve",
      targetType: "user_appeal",
      targetId: appealId,
      after: { status, targetUserId: appeal.userId },
      ip: admin.ip,
    });
    event = await enqueueEventInTx(
      tx,
      "account.appeal.resolved",
      { userId: appeal.userId, appealId, status },
      { actorId: admin.userId, source: "user-appeals" },
    );
  });
  if (event) await dispatchOutboxRows([event]);
  await sweepPending();
}
