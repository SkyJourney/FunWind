import "server-only";

import { and, eq } from "drizzle-orm";
import { forums, getWebDb, sessions, userRestrictions } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { isFutureBeijingDateTime, nowBeijingWallTime } from "@/lib/datetime";
import { lockActiveUserInTx } from "@/lib/identity";
import { restrictionActive } from "@/lib/authz/restrictions";
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

      const target = await lockActiveUserInTx(tx, input.userId);
      if (!target.ok) {
        return { ok: false, code: target.code === "not_found" ? "not_found" : "bad_state" };
      }

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
