import { toDatetime } from "../config.js";
import { TEAM_ROLES } from "../mapping/legacy-roles.js";

export interface BadgeRow {
  id: number;
  key: string;
  name: string;
  description: string;
  icon: string;
  kind: "team" | "honor";
  sortOrder: number;
  isActive: boolean;
}

export interface UserBadgeRow {
  userId: number;
  badgeId: number;
  awardedAt: string;
  expiresAt: string | null;
}

/** 团队徽章 id 区间：与旧勋章 id（≤ 两位数）错开，且重跑稳定 */
export const TEAM_BADGE_ID_BASE = 1000;

export interface BadgesResult {
  badges: BadgeRow[];
  userBadges: UserBadgeRow[];
  stats: {
    medals: number;
    teamBadges: number;
    holdings: number;
    unknownMedalRefs: number;
    orphanUsers: number;
    expiredSkipped: number;
    teamHoldings: number;
  };
}

/**
 * 徽章 = 旧勋章（25 枚，纯展示）+ 团队徽章（由团队角色持有人派生，让 M7 直接有数据展示）。
 * 旧勋章持有关系是 CSV 串，展开成行；以 nw_medal_user 为准。
 */
export function transformBadges(
  medalInfo: readonly {
    medal_id: number;
    name: string;
    image: string | null;
    icon: string | null;
    descrip: string | null;
    isopen: number;
    vieworder: number;
  }[],
  medalUsers: readonly { uid: number; medals: string; expired_time: number }[],
  teamHolders: readonly { userId: number; roleKey: string }[],
  userIds: ReadonlySet<number>,
  asOf: string,
): BadgesResult {
  const stats: BadgesResult["stats"] = {
    medals: 0,
    teamBadges: 0,
    holdings: 0,
    unknownMedalRefs: 0,
    orphanUsers: 0,
    expiredSkipped: 0,
    teamHoldings: 0,
  };
  const badges: BadgeRow[] = [];
  const known = new Set<number>();
  for (const m of [...medalInfo].sort((a, b) => Number(a.medal_id) - Number(b.medal_id))) {
    const id = Number(m.medal_id);
    known.add(id);
    badges.push({
      id,
      key: `medal-${id}`,
      name:
        String(m.name ?? "")
          .trim()
          .slice(0, 64) || `勋章${id}`,
      description: String(m.descrip ?? "").slice(0, 255),
      icon: String(m.image || m.icon || "").slice(0, 100),
      kind: "honor",
      sortOrder: Number(m.vieworder) || 0,
      isActive: Number(m.isopen) > 0,
    });
    stats.medals++;
  }

  const userBadges: UserBadgeRow[] = [];
  const seen = new Set<string>();
  const push = (userId: number, badgeId: number, expiresAt: string | null) => {
    const k = `${userId}:${badgeId}`;
    if (seen.has(k)) return;
    seen.add(k);
    userBadges.push({ userId, badgeId, awardedAt: asOf, expiresAt });
  };

  for (const h of [...medalUsers].sort((a, b) => Number(a.uid) - Number(b.uid))) {
    const uid = Number(h.uid);
    if (!userIds.has(uid)) {
      stats.orphanUsers++;
      continue;
    }
    const expiresAt = toDatetime(Number(h.expired_time));
    if (expiresAt !== null && expiresAt <= asOf) {
      stats.expiredSkipped++;
      continue;
    }
    for (const token of String(h.medals ?? "").split(",")) {
      const mid = parseInt(token.trim(), 10);
      if (!Number.isFinite(mid)) continue;
      if (!known.has(mid)) {
        stats.unknownMedalRefs++;
        continue;
      }
      push(uid, mid, expiresAt);
      stats.holdings++;
    }
  }

  // 团队徽章：每个自定义（团队）角色一枚
  const teamRoles = TEAM_ROLES;
  const teamBadgeId = new Map<string, number>();
  for (const [i, r] of teamRoles.entries()) {
    const id = TEAM_BADGE_ID_BASE + i + 1;
    teamBadgeId.set(r.key, id);
    badges.push({
      id,
      key: r.key,
      name: r.name,
      description: `${r.name}成员`,
      icon: "",
      kind: "team",
      sortOrder: i,
      isActive: true,
    });
    stats.teamBadges++;
  }
  for (const t of [...teamHolders].sort((a, b) => a.userId - b.userId)) {
    const id = teamBadgeId.get(t.roleKey);
    if (id === undefined) continue;
    push(t.userId, id, null);
    stats.teamHoldings++;
  }
  return { badges, userBadges, stats };
}
