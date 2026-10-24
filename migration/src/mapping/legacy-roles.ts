/**
 * 旧用户组（gid）→ 新角色的映射，以及青翼团队角色的定义（迁移适配层知识）。
 * 运行时内置角色只有 guest / member / admin；团队角色是站点数据，由迁移在导入时创建。
 */

/** 旧「禁止发言」用户组：不再是角色，翻译为 user_restrictions（mute） */
export const MUTED_GID = 6;
/** 旧游客组 */
export const GUEST_GID = 2;

/** 内置角色对应的旧 gid（旧 default + LV1–12 合并为 member；大魔王/领主/守卫收编为 admin） */
export const BUILTIN_GIDS: Readonly<Record<"guest" | "member" | "admin", readonly number[]>> = {
  guest: [GUEST_GID],
  member: [1, 8, 9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 33],
  admin: [3, 4, 5],
};

export interface TeamRoleDef {
  key: string;
  name: string;
  description: string;
  /** 旧 gid（旧库实测：23 = 实习组、38 = 策划组） */
  gid: number;
}

/** 青翼团队角色（kind=custom）；每个同时生成一枚团队徽章 */
export const TEAM_ROLES: readonly TeamRoleDef[] = [
  { key: "team-subtitle", name: "字幕制作组", description: "内部版块访问 + 制作协作", gid: 18 },
  { key: "team-tech", name: "技术分流组", description: "", gid: 21 },
  { key: "team-planning", name: "策划组", description: "", gid: 38 },
  { key: "team-resource", name: "资源组", description: "", gid: 36 },
  { key: "team-art", name: "美工组", description: "", gid: 37 },
  { key: "team-intern", name: "实习组", description: "", gid: 23 },
];
