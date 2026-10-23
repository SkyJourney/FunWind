import { ROLE_DEFINITIONS } from "@funwind/db";

/** 旧「禁止发言」用户组：不再是角色，翻译为 user_restrictions（mute） */
export const MUTED_GID = 6;
/** 旧游客组 */
export const GUEST_GID = 2;

/** 旧 gid → 新角色键（来自词汇表 legacyGids，单一事实源） */
const GID_TO_ROLE = new Map<number, string>();
for (const r of ROLE_DEFINITIONS) for (const gid of r.legacyGids) GID_TO_ROLE.set(gid, r.key);

/** 会员组（旧 default + LV1–12）：合并为内置 member 角色 */
export const MEMBER_GIDS: ReadonlySet<number> = new Set(
  ROLE_DEFINITIONS.find((r) => r.key === "member")?.legacyGids ?? [],
);

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
