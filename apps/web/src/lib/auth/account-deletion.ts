import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  accountDeletionTokens,
  emailTokens,
  getWebDb,
  insertIdOf,
  sessions,
  userRestrictions,
  users,
} from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import {
  hasOtherEffectiveSiteAdmin,
  isEffectiveSiteAdmin,
  lockSiteAdminInvariant,
} from "@/lib/authz/site-admin-invariant";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { restrictionActive } from "@/lib/authz/restrictions";
import { type PasswordVerifier, verifyAccountPassword, verifyPassword } from "./password";
import { generateToken, hashToken } from "./token";
import { hashEmailKey } from "./tokens";
import { createSessionInTx, SessionCreationError } from "./session";
import { purgeUserDataInTx, revertUserPollVotes } from "./account-deletion-purge";
import {
  enqueueEventInTx,
  dispatchOutboxRows,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";

const REQUEST_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACCESS_TTL_SECONDS = 35 * 24 * 60 * 60;
const EMAIL_TOKEN_TTL_SECONDS = 60 * 60;

type VerificationMethod = "password" | "verified_email";
type EmailTokenPurpose = "request" | "access";

export class AccountDeletionError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "password_required"
      | "password_invalid"
      | "email_unverified"
      | "not_eligible"
      | "already_pending"
      | "already_completed"
      | "token_invalid"
      | "not_cancellable"
      | "access_expired"
      | "last_admin",
  ) {
    super(code);
    this.name = "AccountDeletionError";
  }
}

async function lockDeletionAdminInvariant(tx: DbTx, userId: number): Promise<void> {
  await lockSiteAdminInvariant(tx);
  if ((await isEffectiveSiteAdmin(tx, userId)) && !(await hasOtherEffectiveSiteAdmin(tx, userId))) {
    throw new AccountDeletionError("last_admin");
  }
}

export interface AccountDeletionRequestResult {
  requestId: number;
  scheduledAt: string;
  accessToken: string;
}

async function createRequestInTx(
  tx: DbTx,
  userId: number,
  verificationMethod: VerificationMethod,
  ip: string | null,
): Promise<AccountDeletionRequestResult> {
  const [user] = await tx
    .select({
      state: users.state,
      passwordHash: users.passwordHash,
      legacyPasswordHash: users.legacyPasswordHash,
      legacyPasswordPending: users.legacyPasswordPending,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for("update");
  if (!user || user.state !== "active") throw new AccountDeletionError("not_eligible");
  if (
    verificationMethod === "verified_email" &&
    (user.passwordHash || user.legacyPasswordHash || user.legacyPasswordPending)
  ) {
    throw new AccountDeletionError("not_eligible");
  }

  const previous = await tx
    .select({ id: accountDeletionRequests.id, status: accountDeletionRequests.status })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, userId),
        inArray(accountDeletionRequests.status, ["pending", "completed"]),
      ),
    )
    .orderBy(desc(accountDeletionRequests.id))
    .limit(1)
    .for("update");
  if (previous[0]?.status === "pending") throw new AccountDeletionError("already_pending");
  if (previous[0]?.status === "completed") throw new AccountDeletionError("already_completed");

  const requestId = insertIdOf(
    await tx.insert(accountDeletionRequests).values({
      userId,
      status: "pending",
      requestedAt: sql`NOW()`,
      scheduledAt: sql`NOW() + INTERVAL ${REQUEST_TTL_SECONDS} SECOND`,
      verificationMethod,
    }),
  );
  const [request] = await tx
    .select({ scheduledAt: accountDeletionRequests.scheduledAt })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, requestId))
    .limit(1);

  const accessToken = generateToken();
  await tx
    .update(accountDeletionRequests)
    .set({
      accessTokenHash: hashToken(accessToken),
      accessExpiresAt: sql`NOW() + INTERVAL ${ACCESS_TTL_SECONDS} SECOND`,
    })
    .where(eq(accountDeletionRequests.id, requestId));
  await tx.delete(sessions).where(eq(sessions.userId, userId));
  await tx.delete(emailTokens).where(eq(emailTokens.userId, userId));

  await writeAudit(tx, {
    actorId: userId,
    action: "account.deletion.requested",
    targetType: "account_deletion",
    targetId: requestId,
    after: { scheduledAt: request!.scheduledAt, verificationMethod },
    ip,
  });
  return { requestId, scheduledAt: request!.scheduledAt, accessToken };
}

export async function requestAccountDeletionWithPassword(
  actor: { userId: number; ip?: string | null },
  currentPassword: string,
): Promise<AccountDeletionRequestResult> {
  const [before] = await getWebDb()
    .select({
      passwordHash: users.passwordHash,
      legacyPasswordHash: users.legacyPasswordHash,
      legacyPasswordPending: users.legacyPasswordPending,
    })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  if (!before) throw new AccountDeletionError("not_found");
  if (before.legacyPasswordPending || !before.passwordHash) {
    throw new AccountDeletionError("password_required");
  }
  if (!(await verifyPassword(before.passwordHash, currentPassword))) {
    throw new AccountDeletionError("password_invalid");
  }

  const enqueued: EnqueuedEvent[] = [];
  const result = await getWebDb().transaction(async (tx) => {
    await lockDeletionAdminInvariant(tx, actor.userId);
    const [locked] = await tx
      .select({ passwordHash: users.passwordHash, state: users.state })
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1)
      .for("update");
    if (!locked || locked.state !== "active") throw new AccountDeletionError("not_eligible");
    if (locked.passwordHash !== before.passwordHash)
      throw new AccountDeletionError("password_invalid");
    const created = await createRequestInTx(tx, actor.userId, "password", actor.ip ?? null);
    enqueued.push(...(await enqueueRequestEvent(tx, created, actor.userId)));
    return created;
  });
  await dispatchOutboxRows(enqueued);
  await sweepPending();
  return result;
}

export async function issueAccountDeletionEmailToken(
  userId: number,
  purpose: EmailTokenPurpose,
): Promise<{ email: string; token: string } | null> {
  return getWebDb().transaction(async (tx) => {
    const [user] = await tx
      .select({
        email: users.email,
        emailKey: users.emailKey,
        emailVerifiedAt: users.emailVerifiedAt,
        passwordHash: users.passwordHash,
        legacyPasswordHash: users.legacyPasswordHash,
        state: users.state,
        legacyPasswordPending: users.legacyPasswordPending,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    if (
      !user ||
      user.state !== "active" ||
      !user.email ||
      !user.emailKey ||
      !user.emailVerifiedAt
    ) {
      throw new AccountDeletionError("email_unverified");
    }
    if (
      purpose === "request" &&
      (user.passwordHash || user.legacyPasswordHash || user.legacyPasswordPending)
    ) {
      throw new AccountDeletionError("not_eligible");
    }
    const [request] = await tx
      .select({ id: accountDeletionRequests.id, status: accountDeletionRequests.status })
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.userId, userId))
      .orderBy(desc(accountDeletionRequests.id))
      .limit(1)
      .for("update");
    if (purpose === "request" && request?.status === "pending") {
      throw new AccountDeletionError("already_pending");
    }
    if (purpose === "request" && request?.status === "completed") {
      throw new AccountDeletionError("already_completed");
    }
    if (purpose === "access" && request?.status !== "pending") {
      throw new AccountDeletionError("not_eligible");
    }

    await tx
      .delete(accountDeletionTokens)
      .where(
        and(eq(accountDeletionTokens.userId, userId), eq(accountDeletionTokens.purpose, purpose)),
      );
    const token = generateToken();
    await tx.insert(accountDeletionTokens).values({
      id: hashToken(token),
      userId,
      purpose,
      emailKeySnapshot: hashEmailKey(user.emailKey),
      createdAt: sql`NOW()`,
      expiresAt: sql`NOW() + INTERVAL ${EMAIL_TOKEN_TTL_SECONDS} SECOND`,
    });
    return { email: user.email, token };
  });
}

export async function issueAccountDeletionAccessForEmail(
  email: string,
): Promise<{ email: string; token: string } | null> {
  return issueAccountDeletionEmailForPurpose(email, "access");
}

export async function issueAccountDeletionRequestForEmail(
  email: string,
): Promise<{ email: string; token: string } | null> {
  return issueAccountDeletionEmailForPurpose(email, "request");
}

async function issueAccountDeletionEmailForPurpose(
  email: string,
  purpose: EmailTokenPurpose,
): Promise<{ email: string; token: string } | null> {
  const key = email.trim().toLowerCase();
  const [user] = await getWebDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailKey, key))
    .limit(1);
  if (!user) return null;
  try {
    return await issueAccountDeletionEmailToken(user.id, purpose);
  } catch {
    return null;
  }
}

async function createClosureAccessInTx(
  tx: DbTx,
  userId: number,
): Promise<{ requestId: number; accessToken: string }> {
  const [request] = await tx
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, userId),
        eq(accountDeletionRequests.status, "pending"),
      ),
    )
    .orderBy(desc(accountDeletionRequests.id))
    .limit(1)
    .for("update");
  if (!request) throw new AccountDeletionError("not_eligible");
  const accessToken = generateToken();
  await tx
    .update(accountDeletionRequests)
    .set({
      accessTokenHash: hashToken(accessToken),
      accessExpiresAt: sql`NOW() + INTERVAL ${ACCESS_TTL_SECONDS} SECOND`,
    })
    .where(eq(accountDeletionRequests.id, request.id));
  return { requestId: request.id, accessToken };
}

export async function consumeAccountDeletionEmailToken(
  token: string,
): Promise<AccountDeletionRequestResult | { requestId: number; accessToken: string } | null> {
  if (!token) return null;
  const id = hashToken(token);
  const [candidate] = await getWebDb()
    .select({ userId: accountDeletionTokens.userId, purpose: accountDeletionTokens.purpose })
    .from(accountDeletionTokens)
    .where(eq(accountDeletionTokens.id, id))
    .limit(1);
  if (!candidate) return null;

  const enqueued: EnqueuedEvent[] = [];
  const result = await getWebDb().transaction(async (tx) => {
    if (candidate.purpose === "request") {
      await lockDeletionAdminInvariant(tx, candidate.userId);
    }
    const [user] = await tx
      .select({
        state: users.state,
        emailKey: users.emailKey,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, candidate.userId))
      .limit(1)
      .for("update");
    const [row] = await tx
      .select({
        userId: accountDeletionTokens.userId,
        purpose: accountDeletionTokens.purpose,
        emailKeySnapshot: accountDeletionTokens.emailKeySnapshot,
        usedAt: accountDeletionTokens.usedAt,
        isLive: sql<boolean>`${accountDeletionTokens.expiresAt} > NOW()`.mapWith(Boolean),
      })
      .from(accountDeletionTokens)
      .where(eq(accountDeletionTokens.id, id))
      .limit(1)
      .for("update");
    if (
      !user ||
      user.state !== "active" ||
      !user.emailKey ||
      !user.emailVerifiedAt ||
      !row ||
      row.userId !== candidate.userId ||
      row.purpose !== candidate.purpose ||
      row.usedAt !== null ||
      !row.isLive ||
      row.emailKeySnapshot !== hashEmailKey(user.emailKey)
    ) {
      return null;
    }
    const changed = await tx
      .update(accountDeletionTokens)
      .set({ usedAt: sql`NOW()` })
      .where(
        and(
          eq(accountDeletionTokens.id, id),
          sql`${accountDeletionTokens.usedAt} IS NULL`,
          sql`${accountDeletionTokens.expiresAt} > NOW()`,
        ),
      );
    if (((changed as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0) === 0) {
      return null;
    }

    if (candidate.purpose === "request") {
      const created = await createRequestInTx(tx, candidate.userId, "verified_email", null);
      const events = await enqueueRequestEvent(tx, created, candidate.userId);
      enqueued.push(...events);
      return created;
    }

    return createClosureAccessInTx(tx, candidate.userId);
  });
  if (result && "scheduledAt" in result) {
    await dispatchOutboxRows(enqueued);
    await sweepPending();
  }
  return result;
}

async function enqueueRequestEvent(
  tx: DbTx,
  request: AccountDeletionRequestResult,
  userId: number,
): Promise<EnqueuedEvent[]> {
  const event = await enqueueEventInTx(
    tx,
    "account.deletion.requested",
    { userId, requestId: request.requestId, scheduledAt: request.scheduledAt },
    { actorId: userId, source: "account-deletion" },
  );
  return [event];
}

export async function cancelAccountDeletion(
  accessToken: string,
  meta: { ip?: string | null; userAgent?: string } = {},
): Promise<{ sessionToken: string | null; userId: number } | null> {
  if (!accessToken) return null;
  const tokenHash = hashToken(accessToken);
  const [candidate] = await getWebDb()
    .select({ userId: accountDeletionRequests.userId })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.accessTokenHash, tokenHash))
    .limit(1);
  if (!candidate) return null;

  let enqueued: EnqueuedEvent | null = null;
  const result = await getWebDb().transaction(async (tx) => {
    const [user] = await tx
      .select({ state: users.state })
      .from(users)
      .where(eq(users.id, candidate.userId))
      .limit(1)
      .for("update");
    const [request] = await tx
      .select({ id: accountDeletionRequests.id, scheduledAt: accountDeletionRequests.scheduledAt })
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.userId, candidate.userId),
          eq(accountDeletionRequests.accessTokenHash, tokenHash),
          eq(accountDeletionRequests.status, "pending"),
          sql`${accountDeletionRequests.accessExpiresAt} > NOW()`,
        ),
      )
      .orderBy(desc(accountDeletionRequests.id))
      .limit(1)
      .for("update");
    if (!user || user.state !== "active" || !request) return null;
    const [due] = await tx
      .select({ id: accountDeletionRequests.id })
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.id, request.id),
          sql`${accountDeletionRequests.scheduledAt} <= NOW()`,
        ),
      )
      .limit(1);
    if (due) throw new AccountDeletionError("not_cancellable");

    await tx
      .update(accountDeletionRequests)
      .set({
        status: "cancelled",
        cancelledAt: sql`NOW()`,
        accessTokenHash: null,
        accessExpiresAt: null,
      })
      .where(eq(accountDeletionRequests.id, request.id));
    await tx.delete(sessions).where(eq(sessions.userId, candidate.userId));
    const [ban] = await tx
      .select({ id: userRestrictions.id })
      .from(userRestrictions)
      .where(
        and(
          eq(userRestrictions.userId, candidate.userId),
          eq(userRestrictions.kind, "ban"),
          eq(userRestrictions.scopeId, 0),
          restrictionActive,
        ),
      )
      .limit(1)
      .for("update");
    // 封禁与登录验证门（M11.3）一视同仁：撤销注销本身照常成功，只是不替用户建会话——
    // 抛错会让整个撤销事务回滚，用户的注销申请反而撤销不掉。未验证账号撤销后按正常流程登录，会在那里被登录门拦下。
    let sessionToken: string | null = null;
    if (!ban) {
      try {
        sessionToken = await createSessionInTx(tx, candidate.userId, meta);
      } catch (error) {
        if (!(error instanceof SessionCreationError && error.code === "email_unverified")) {
          throw error;
        }
      }
    }
    await writeAudit(tx, {
      actorId: candidate.userId,
      action: "account.deletion.cancelled",
      targetType: "account_deletion",
      targetId: request.id,
      after: { cancelled: true },
      ip: meta.ip ?? null,
    });
    enqueued = await enqueueEventInTx(
      tx,
      "account.deletion.cancelled",
      { userId: candidate.userId, requestId: request.id },
      { actorId: candidate.userId, source: "account-deletion" },
    );
    return { sessionToken, userId: candidate.userId };
  });
  if (enqueued) await dispatchOutboxRows([enqueued]);
  await sweepPending();
  return result;
}

export async function startOrOpenAccountDeletionWithPassword(
  identifier: string,
  password: string,
  ip: string | null,
  deps: { verify?: PasswordVerifier } = {},
): Promise<{ requestId: number; accessToken: string; started: boolean } | null> {
  const key = identifier.trim().toLowerCase();
  if (!key || !password) {
    await verifyAccountPassword(null, password, deps.verify);
    return null;
  }
  const [user] = await getWebDb()
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(sql`(${users.usernameKey} = ${key} OR ${users.emailKey} = ${key})`)
    .limit(1);
  const passwordOk = await verifyAccountPassword(user?.passwordHash ?? null, password, deps.verify);
  if (!user || !passwordOk) return null;

  const enqueued: EnqueuedEvent[] = [];
  const result = await getWebDb().transaction(async (tx) => {
    await lockDeletionAdminInvariant(tx, user.id);
    const [locked] = await tx
      .select({ passwordHash: users.passwordHash, state: users.state })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
      .for("update");
    if (!locked || locked.state !== "active" || locked.passwordHash !== user.passwordHash) {
      return null;
    }
    const [previous] = await tx
      .select({ status: accountDeletionRequests.status })
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.userId, user.id))
      .orderBy(desc(accountDeletionRequests.id))
      .limit(1)
      .for("update");
    if (previous?.status === "completed") throw new AccountDeletionError("already_completed");
    if (previous?.status === "pending") {
      return { ...(await createClosureAccessInTx(tx, user.id)), started: false };
    }
    const created = await createRequestInTx(tx, user.id, "password", ip);
    enqueued.push(...(await enqueueRequestEvent(tx, created, user.id)));
    return { requestId: created.requestId, accessToken: created.accessToken, started: true };
  });
  await dispatchOutboxRows(enqueued);
  await sweepPending();
  return result;
}

async function completeAccountDeletion(requestId: number): Promise<boolean> {
  const [candidate] = await getWebDb()
    .select({ userId: accountDeletionRequests.userId })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, requestId))
    .limit(1);
  if (!candidate) return false;

  return withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, candidate.userId))
        .limit(1)
        .for("update");
      if (!user) throw new Error("user_missing");

      const [request] = await tx
        .select({ id: accountDeletionRequests.id })
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.id, requestId),
            eq(accountDeletionRequests.userId, candidate.userId),
            eq(accountDeletionRequests.status, "pending"),
            sql`${accountDeletionRequests.scheduledAt} <= NOW()`,
          ),
        )
        .limit(1)
        .for("update");
      if (!request) return false;

      await revertUserPollVotes(tx, candidate.userId);
      await purgeUserDataInTx(tx, candidate.userId);
      const userId = candidate.userId;
      await tx
        .update(accountDeletionRequests)
        .set({ status: "completed", completedAt: sql`NOW()`, lastErrorCode: null })
        .where(eq(accountDeletionRequests.id, requestId));
      await writeAudit(tx, {
        actorId: null,
        action: "account.deletion.completed",
        targetType: "account_deletion",
        targetId: requestId,
        after: { userId, completed: true },
        ip: null,
      });
      return true;
    }, POINTS_TX_OPTIONS),
  );
}

export async function processDueAccountDeletions(limit = 50): Promise<{
  checked: number;
  completed: number;
  failed: number;
}> {
  const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit) || 50));
  const due = await getWebDb()
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.status, "pending"),
        sql`${accountDeletionRequests.scheduledAt} <= NOW()`,
      ),
    )
    .orderBy(accountDeletionRequests.scheduledAt, accountDeletionRequests.id)
    .limit(safeLimit);
  let completed = 0;
  let failed = 0;
  for (const row of due) {
    try {
      if (await completeAccountDeletion(row.id)) completed += 1;
    } catch {
      failed += 1;
      await getWebDb()
        .update(accountDeletionRequests)
        .set({
          attemptCount: sql`${accountDeletionRequests.attemptCount} + 1`,
          lastAttemptAt: sql`NOW()`,
          lastErrorCode: "processing_failed",
        })
        .where(
          and(
            eq(accountDeletionRequests.id, row.id),
            eq(accountDeletionRequests.status, "pending"),
          ),
        );
    }
  }
  return { checked: due.length, completed, failed };
}
