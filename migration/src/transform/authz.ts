import { DEFAULT_ROLE_GRANTS, isKnownPermission } from "@funwind/db";
import { toDatetime } from "../config.js";
import {
  LEGACY_CONDITION_KEYS,
  LEGACY_PERMISSION_KEYS,
  THREAD_EXTEND_KEY,
} from "../mapping/legacy-permissions.js";
import { isTruthy, parsePermissionValue, type PhpValue } from "../lib/php-serialize.js";
import { MUTED_GID, roleOfGid } from "./legacy-groups.js";

export interface OldPermRow {
  gid: number;
  rkey: string;
  rvalue: string | null;
}

export interface GlobalGrant {
  roleKey: string;
  permissionKey: string;
}

/** 旧 rkey → 新权限点（mapping/legacy-permissions）；allow_thread_extend 由 threadExtendPerms 单独处理 */
const RKEY_TO_PERMS = new Map<string, readonly string[]>(Object.entries(LEGACY_PERMISSION_KEYS));

/** 版块读权限由 forums.read_policy 表达，不翻译成全局授权 */
const POLICY_RKEYS = new Set(["allow_read"]);

/**
 * 版主操作键：旧站 operate_thread 对普通会员组只是设置（置顶有效时长等），不是开关；
 * 版主权限在新模型里只能通过 forum.moderate 的作用域授权获得，**绝不能由全局权限表翻译出来**。
 */
const MODERATION_RKEYS = new Set(["operate_thread"]);

/**
 * 允许以「开关数组」形态出现的旧键：allow_thread_extend（sell/hide）与后台面板键 panel_*。
 * 其它键如果出现数组值，说明它是设置而非开关，不得按真值翻译成授权。
 */
const isFlagArrayKey = (rkey: string) => rkey === THREAD_EXTEND_KEY || rkey.startsWith("panel_");

export interface AuthzTransformResult {
  grants: GlobalGrant[];
  stats: {
    rows: number;
    /** 属于未映射 gid 的行数（按 gid） */
    unmappedGids: Map<number, number>;
    /** 条件参数型旧键 */
    conditionKeys: Map<string, number>;
    /** 词汇表没有对应的旧键（按 rkey）——多为已取消功能 */
    unmappedKeys: Map<string, number>;
    skippedPolicy: number;
    skippedModeration: number;
    /** 非开关键出现了数组值（设置而非开关）——按未映射处理并计数 */
    unexpectedArrays: Map<string, number>;
    skippedMutedGroup: number;
    parseErrors: { gid: number; rkey: string; value: string }[];
    /** 会员权限的「最宽并集」：只有部分会员组开启的权限点 */
    memberPartial: { permissionKey: string; granted: number[]; missing: number[] }[];
  };
}

const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

/** allow_thread_extend 是数组：sell → gate.points，hide → gate.reply */
function threadExtendPerms(v: PhpValue): string[] {
  if (typeof v !== "object" || v === null) return [];
  const out: string[] = [];
  if (isTruthy(v.sell ?? null)) out.push("gate.points");
  if (isTruthy(v.hide ?? null)) out.push("gate.reply");
  return out;
}

export function translateGlobalGrants(rows: readonly OldPermRow[]): AuthzTransformResult {
  const stats: AuthzTransformResult["stats"] = {
    rows: rows.length,
    unmappedGids: new Map(),
    conditionKeys: new Map(),
    unmappedKeys: new Map(),
    skippedPolicy: 0,
    skippedModeration: 0,
    unexpectedArrays: new Map(),
    skippedMutedGroup: 0,
    parseErrors: [],
    memberPartial: [],
  };
  const granted = new Set<string>(); // `${roleKey}\u0000${permissionKey}`
  const memberGids = new Set<number>();
  const memberGrantedBy = new Map<string, Set<number>>(); // permissionKey → 开启它的会员组

  for (const r of rows) {
    const gid = Number(r.gid);
    if (gid === MUTED_GID) {
      stats.skippedMutedGroup++;
      continue;
    }
    const roleKey = roleOfGid(gid);
    if (!roleKey) {
      bump(stats.unmappedGids, gid);
      continue;
    }
    if (roleKey === "member") memberGids.add(gid);

    let perms: readonly string[];
    if (POLICY_RKEYS.has(r.rkey)) {
      stats.skippedPolicy++;
      continue;
    } else if (MODERATION_RKEYS.has(r.rkey)) {
      stats.skippedModeration++;
      continue;
    } else if (r.rkey === THREAD_EXTEND_KEY || RKEY_TO_PERMS.has(r.rkey)) {
      let value: PhpValue;
      try {
        value = parsePermissionValue(r.rvalue);
      } catch {
        stats.parseErrors.push({ gid, rkey: r.rkey, value: String(r.rvalue ?? "").slice(0, 80) });
        continue;
      }
      if (typeof value === "object" && value !== null && !isFlagArrayKey(r.rkey)) {
        bump(stats.unexpectedArrays, r.rkey);
        continue;
      }
      perms =
        r.rkey === THREAD_EXTEND_KEY
          ? threadExtendPerms(value)
          : isTruthy(value)
            ? RKEY_TO_PERMS.get(r.rkey)!
            : [];
    } else if (LEGACY_CONDITION_KEYS[r.rkey]) {
      bump(stats.conditionKeys, r.rkey);
      continue;
    } else {
      bump(stats.unmappedKeys, r.rkey);
      continue;
    }

    for (const perm of perms) {
      granted.add(`${roleKey}\u0000${perm}`);
      if (roleKey === "member") {
        const set = memberGrantedBy.get(perm) ?? new Set<number>();
        set.add(gid);
        memberGrantedBy.set(perm, set);
      }
    }
  }

  // 管理员：词汇表基线（后台入口等）与翻译结果取并集
  for (const perm of DEFAULT_ROLE_GRANTS.admin) granted.add(`admin\u0000${perm}`);

  for (const [permissionKey, gids] of [...memberGrantedBy].sort(([a], [b]) => a.localeCompare(b))) {
    const missing = [...memberGids].filter((g) => !gids.has(g)).sort((a, b) => a - b);
    if (missing.length > 0) {
      stats.memberPartial.push({
        permissionKey,
        granted: [...gids].sort((a, b) => a - b),
        missing,
      });
    }
  }

  const grants = [...granted]
    .map((k) => {
      const [roleKey, permissionKey] = k.split("\u0000") as [string, string];
      return { roleKey, permissionKey };
    })
    // 防御：不允许词汇表外的权限点进入授权表（v1 的脏键根因）
    .filter((g) => isKnownPermission(g.permissionKey))
    .sort(
      (a, b) =>
        a.roleKey.localeCompare(b.roleKey) || a.permissionKey.localeCompare(b.permissionKey),
    );
  return { grants, stats };
}

// ---------- 用户角色绑定 ----------

export interface OldBelong {
  uid: number;
  gid: number;
  endtime: number;
}

export interface UserRoleRow {
  userId: number;
  roleKey: string;
  scopeId: number;
  expiresAt: string | null;
  grantedBy: null;
  grantedAt: string;
}

export interface UserRoleResult {
  rows: UserRoleRow[];
  stats: {
    sources: number;
    unmappedGids: Map<number, number>;
    implicitSkipped: number;
    expiredSkipped: number;
    orphanUsers: number;
    mutedGroupSkipped: number;
  };
}

/** 主组 + 附加组 → user_roles；会员/游客是隐式角色不落行；禁言组走 user_restrictions */
export function translateUserRoles(
  belong: readonly OldBelong[],
  mainGroups: readonly { uid: number; gid: number }[],
  existingUids: ReadonlySet<number>,
  asOf: string,
): UserRoleResult {
  const stats: UserRoleResult["stats"] = {
    sources: belong.length + mainGroups.length,
    unmappedGids: new Map(),
    implicitSkipped: 0,
    expiredSkipped: 0,
    orphanUsers: 0,
    mutedGroupSkipped: 0,
  };
  const best = new Map<string, UserRoleRow>();

  const consider = (uid: number, gid: number, endtime: number) => {
    if (gid === MUTED_GID) {
      stats.mutedGroupSkipped++;
      return;
    }
    const roleKey = roleOfGid(gid);
    if (!roleKey) {
      bump(stats.unmappedGids, gid);
      return;
    }
    if (roleKey === "member" || roleKey === "guest") {
      stats.implicitSkipped++;
      return;
    }
    if (!existingUids.has(uid)) {
      stats.orphanUsers++;
      return;
    }
    const expiresAt = toDatetime(endtime);
    if (expiresAt !== null && expiresAt <= asOf) {
      stats.expiredSkipped++;
      return;
    }
    const key = `${uid}\u0000${roleKey}`;
    const prev = best.get(key);
    // 永久优先；都带过期则取更晚者
    const better =
      !prev || (prev.expiresAt !== null && (expiresAt === null || expiresAt > prev.expiresAt));
    if (better) {
      best.set(key, {
        userId: uid,
        roleKey,
        scopeId: 0,
        expiresAt,
        grantedBy: null,
        grantedAt: asOf,
      });
    }
  };

  for (const b of belong) consider(Number(b.uid), Number(b.gid), Number(b.endtime));
  for (const m of mainGroups) consider(Number(m.uid), Number(m.gid), 0);

  const rows = [...best.values()].sort(
    (a, b) => a.userId - b.userId || a.roleKey.localeCompare(b.roleKey),
  );
  return { rows, stats };
}
