import { BUILTIN_GIDS, GUEST_GID, MUTED_GID, TEAM_ROLES } from "../mapping/legacy-roles.js";

export { GUEST_GID, MUTED_GID };

/** 旧 gid → 新角色键（来自 mapping/legacy-roles，单一事实源） */
const GID_TO_ROLE = new Map<number, string>();
for (const [role, gids] of Object.entries(BUILTIN_GIDS)) {
  for (const gid of gids) GID_TO_ROLE.set(gid, role);
}
for (const t of TEAM_ROLES) GID_TO_ROLE.set(t.gid, t.key);

/** 会员组（旧 default + LV1–12）：合并为内置 member 角色 */
export const MEMBER_GIDS: ReadonlySet<number> = new Set(BUILTIN_GIDS.member);

export function roleOfGid(gid: number): string | undefined {
  return GID_TO_ROLE.get(gid);
}

/** 解析旧站逗号分隔的 gid 列表 */
export function parseGidList(csv: string | null | undefined): number[] {
  return String(csv ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

/** 角色是否是需要显式作用域授权的「团队/自定义角色」（member/guest/admin 不需要） */
export function isScopedRole(roleKey: string): boolean {
  return !["member", "guest", "admin"].includes(roleKey);
}
