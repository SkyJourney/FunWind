import { toDatetime } from "../config.js";

export interface OldBan {
  id: number;
  uid: number;
  typeid: number;
  fid: number;
  end_time: number;
  created_userid: number;
  created_time: number;
  reason: string | null;
}

/** 附加组/主组里属于「禁止发言」组的成员（endtime=0 表示永久） */
export interface MutedGroupMember {
  uid: number;
  endtime: number;
}

export interface RestrictionRow {
  id: number;
  userId: number;
  kind: "mute" | "no_avatar" | "no_signature";
  scopeId: number;
  reason: string;
  startsAt: string;
  endsAt: string | null;
  createdBy: number | null;
  createdAt: string;
}

/** 旧 nw_user_ban.typeid：1 = 禁止发言，2 = 禁止头像，4 = 禁止签名（旧站从无「禁止登录」类封禁） */
const KIND_OF_TYPE: Record<number, RestrictionRow["kind"]> = {
  1: "mute",
  2: "no_avatar",
  4: "no_signature",
};

/** 禁言组派生记录的确定性 id 偏移，避免与旧封禁 id 冲突且重跑一致 */
export const GROUP_MUTE_ID_BASE = 1_000_000;

export interface RestrictionResult {
  rows: RestrictionRow[];
  stats: {
    fromBans: number;
    fromGroup: number;
    expiredSkipped: number;
    unknownType: number;
    orphanUsers: number;
    groupDeduped: number;
  };
}

export function transformRestrictions(
  bans: readonly OldBan[],
  groupMutes: readonly MutedGroupMember[],
  existingUids: ReadonlySet<number>,
  asOf: string,
): RestrictionResult {
  const stats = {
    fromBans: 0,
    fromGroup: 0,
    expiredSkipped: 0,
    unknownType: 0,
    orphanUsers: 0,
    groupDeduped: 0,
  };
  const rows: RestrictionRow[] = [];
  const activeMute = new Set<number>();

  for (const b of [...bans].sort((x, y) => Number(x.id) - Number(y.id))) {
    const kind = KIND_OF_TYPE[Number(b.typeid)];
    if (!kind) {
      stats.unknownType++;
      continue;
    }
    if (!existingUids.has(Number(b.uid))) {
      stats.orphanUsers++;
      continue;
    }
    const endsAt = toDatetime(b.end_time);
    if (endsAt !== null && endsAt <= asOf) {
      stats.expiredSkipped++;
      continue;
    }
    const startsAt = toDatetime(b.created_time) ?? asOf;
    rows.push({
      id: Number(b.id),
      userId: Number(b.uid),
      kind,
      scopeId: Number(b.fid) > 0 ? Number(b.fid) : 0,
      reason: String(b.reason ?? "").slice(0, 255),
      startsAt,
      endsAt,
      createdBy: Number(b.created_userid) > 0 ? Number(b.created_userid) : null,
      createdAt: startsAt,
    });
    if (kind === "mute") activeMute.add(Number(b.uid));
    stats.fromBans++;
  }

  // 禁言组成员：已有生效的禁言记录则不重复派生
  const seen = new Set<number>();
  for (const m of [...groupMutes].sort((x, y) => Number(x.uid) - Number(y.uid))) {
    const uid = Number(m.uid);
    if (!existingUids.has(uid)) {
      stats.orphanUsers++;
      continue;
    }
    if (seen.has(uid)) continue;
    seen.add(uid);
    const endsAt = toDatetime(m.endtime);
    if (endsAt !== null && endsAt <= asOf) {
      stats.expiredSkipped++;
      continue;
    }
    if (activeMute.has(uid)) {
      stats.groupDeduped++;
      continue;
    }
    rows.push({
      id: GROUP_MUTE_ID_BASE + uid,
      userId: uid,
      kind: "mute",
      scopeId: 0,
      reason: "旧站「禁止发言」用户组",
      startsAt: asOf,
      endsAt,
      createdBy: null,
      createdAt: asOf,
    });
    stats.fromGroup++;
  }

  return { rows, stats };
}
