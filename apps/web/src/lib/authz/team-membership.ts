import { and, eq, inArray } from "drizzle-orm";
import {
  accountDeletionRequests,
  badges,
  getWebDb,
  roles,
  roleGrants,
  userBadges,
  userRoles,
  users,
} from "@funwind/db";
import { writeAudit, type ConfigActor } from "@/lib/audit";
import { nowBeijingWallTime, parseDbDateTime } from "@/lib/datetime";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { AdminError } from "./admin";
import { hasEffectiveSiteAdmin, lockSiteAdminInvariant } from "./site-admin-invariant";
import {
  isTeamMembershipRole,
  teamBadgeKeyForRole,
  type TeamMembershipRoleKey,
} from "./team-role-mapping";

export interface TeamMembershipRequest {
  userId: number;
  roleKey: TeamMembershipRoleKey;
  expiresAt: string | null;
  reason: string;
}

function validFutureDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month! - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) {
    return false;
  }
  return parseDbDateTime(value).getTime() > Date.now();
}

/** 团队角色与同名 team 徽章同事务授予、续期或修复。 */
export async function assignTeamMembership(
  actor: ConfigActor & { userId: number },
  input: TeamMembershipRequest,
): Promise<void> {
  if (!isTeamMembershipRole(input.roleKey)) throw new AdminError("团队角色不存在");
  if (input.expiresAt !== null && !validFutureDateTime(input.expiresAt)) {
    throw new AdminError("到期时间必须是有效的未来北京时间");
  }
  const reason = input.reason.trim();
  if (!reason) throw new AdminError("必须填写授予理由");
  if (reason.length > 255) throw new AdminError("授予理由不能超过 255 个字符");
  const badgeKey = teamBadgeKeyForRole(input.roleKey);
  let enqueued: EnqueuedEvent[] = [];

  await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      enqueued = [];
      await lockSiteAdminInvariant(tx);
      const [target] = await tx
        .select({ id: users.id, state: users.state })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for("update");
      if (!target || target.state !== "active") throw new AdminError("用户不存在或已注销");

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
      if (closure) throw new AdminError("用户正在注销或已注销");

      const [role] = await tx
        .select({ key: roles.key, kind: roles.kind, name: roles.name })
        .from(roles)
        .where(eq(roles.key, input.roleKey))
        .limit(1)
        .for("share");
      if (!role || role.kind !== "custom") throw new AdminError("团队角色不存在或不是自定义角色");
      const [badge] = await tx
        .select({ id: badges.id, name: badges.name, isActive: badges.isActive, kind: badges.kind })
        .from(badges)
        .where(eq(badges.key, badgeKey))
        .limit(1)
        .for("share");
      if (!badge || badge.kind !== "team" || !badge.isActive) {
        throw new AdminError("对应团队徽章不存在或已停用");
      }

      const [roleHolder] = await tx
        .select({ id: userRoles.id, expiresAt: userRoles.expiresAt })
        .from(userRoles)
        .where(
          and(
            eq(userRoles.userId, input.userId),
            eq(userRoles.roleKey, input.roleKey),
            eq(userRoles.scopeId, 0),
          ),
        )
        .limit(1)
        .for("update");
      const [badgeHolder] = await tx
        .select({ expiresAt: userBadges.expiresAt })
        .from(userBadges)
        .where(and(eq(userBadges.userId, input.userId), eq(userBadges.badgeId, badge.id)))
        .limit(1)
        .for("update");
      const now = nowBeijingWallTime();
      const badgeWasNotActive =
        !badgeHolder || (badgeHolder.expiresAt !== null && badgeHolder.expiresAt <= now);
      const changed =
        !roleHolder ||
        roleHolder.expiresAt !== input.expiresAt ||
        !badgeHolder ||
        badgeHolder.expiresAt !== input.expiresAt;
      if (!changed) return;

      await tx
        .insert(userRoles)
        .values({
          userId: input.userId,
          roleKey: input.roleKey,
          scopeId: 0,
          expiresAt: input.expiresAt,
          grantedBy: actor.userId,
          grantedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: { expiresAt: input.expiresAt, grantedBy: actor.userId, grantedAt: now },
        });
      await tx
        .insert(userBadges)
        .values({
          userId: input.userId,
          badgeId: badge.id,
          awardedAt: now,
          awardedBy: actor.userId,
          expiresAt: input.expiresAt,
        })
        .onDuplicateKeyUpdate({
          set: { awardedAt: now, awardedBy: actor.userId, expiresAt: input.expiresAt },
        });
      await writeAudit(tx, {
        actorId: actor.userId,
        action: "team_membership.assign",
        targetType: "user",
        targetId: input.userId,
        before: {
          roleExpiresAt: roleHolder?.expiresAt ?? null,
          badgeExpiresAt: badgeHolder?.expiresAt ?? null,
        },
        after: {
          roleKey: input.roleKey,
          badgeKey,
          scopeId: 0,
          expiresAt: input.expiresAt,
          reason,
        },
        ip: actor.ip,
      });
      enqueued.push(
        await enqueueEventInTx(
          tx,
          "role.changed",
          {
            userId: input.userId,
            roleKey: input.roleKey,
            scopeId: 0,
            action: "granted",
            operatorId: actor.userId,
            expiresAt: input.expiresAt,
          },
          { actorId: actor.userId, source: "team-membership" },
        ),
      );
      if (badgeWasNotActive) {
        enqueued.push(
          await enqueueEventInTx(
            tx,
            "badge.awarded",
            { userId: input.userId, badgeId: badge.id },
            { actorId: actor.userId, source: "team-membership" },
          ),
        );
      }
    }, POINTS_TX_OPTIONS),
  );
  await dispatchOutboxRows(enqueued);
  await sweepPending();
}

/** 团队角色与对应徽章同事务收回；重复收回是幂等空操作。 */
export async function revokeTeamMembership(
  actor: ConfigActor & { userId: number },
  userId: number,
  roleKey: string,
  reason: string,
): Promise<void> {
  if (!isTeamMembershipRole(roleKey)) throw new AdminError("团队角色不存在");
  const why = reason.trim();
  if (!why) throw new AdminError("必须填写撤销理由");
  if (why.length > 255) throw new AdminError("撤销理由不能超过 255 个字符");
  const badgeKey = teamBadgeKeyForRole(roleKey);
  let enqueued: EnqueuedEvent[] = [];

  await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      enqueued = [];
      await lockSiteAdminInvariant(tx);
      const [target] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!target) throw new AdminError("用户不存在");
      const [roleHolder] = await tx
        .select({ id: userRoles.id, expiresAt: userRoles.expiresAt })
        .from(userRoles)
        .where(
          and(
            eq(userRoles.userId, userId),
            eq(userRoles.roleKey, roleKey),
            eq(userRoles.scopeId, 0),
          ),
        )
        .limit(1)
        .for("update");
      const [badgeHolder] = await tx
        .select({ id: userBadges.badgeId, expiresAt: userBadges.expiresAt })
        .from(userBadges)
        .innerJoin(badges, eq(badges.id, userBadges.badgeId))
        .where(and(eq(userBadges.userId, userId), eq(badges.key, badgeKey)))
        .limit(1)
        .for("update");
      const adminGrants = roleHolder
        ? await tx
            .select({ id: roleGrants.id })
            .from(roleGrants)
            .where(
              and(
                eq(roleGrants.roleKey, roleKey),
                eq(roleGrants.scopeId, 0),
                inArray(roleGrants.permissionKey, ["site.admin", "admin.roles"]),
              ),
            )
        : [];
      if (!roleHolder && !badgeHolder) return;

      if (roleHolder) await tx.delete(userRoles).where(eq(userRoles.id, roleHolder.id));
      if (badgeHolder) {
        await tx
          .delete(userBadges)
          .where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badgeHolder.id)));
      }
      if (adminGrants.length > 0 && !(await hasEffectiveSiteAdmin(tx))) {
        throw new AdminError("至少保留一位可以登录并管理角色的有效站点管理员");
      }
      await writeAudit(tx, {
        actorId: actor.userId,
        action: "team_membership.revoke",
        targetType: "user",
        targetId: userId,
        before: {
          roleKey: roleHolder ? { roleKey, scopeId: 0, expiresAt: roleHolder.expiresAt } : null,
          badgeKey: badgeHolder ? { badgeKey, expiresAt: badgeHolder.expiresAt } : null,
        },
        after: { reason: why },
        ip: actor.ip,
      });
      if (roleHolder) {
        enqueued.push(
          await enqueueEventInTx(
            tx,
            "role.changed",
            {
              userId,
              roleKey,
              scopeId: 0,
              action: "revoked",
              operatorId: actor.userId,
              expiresAt: roleHolder.expiresAt,
            },
            { actorId: actor.userId, source: "team-membership" },
          ),
        );
      }
      if (badgeHolder) {
        const [badge] = await tx
          .select({ id: badges.id })
          .from(badges)
          .where(eq(badges.key, badgeKey))
          .limit(1);
        if (badge) {
          enqueued.push(
            await enqueueEventInTx(
              tx,
              "badge.revoked",
              { userId, badgeId: badge.id },
              { actorId: actor.userId, source: "team-membership" },
            ),
          );
        }
      }
    }, POINTS_TX_OPTIONS),
  );
  await dispatchOutboxRows(enqueued);
  await sweepPending();
}
