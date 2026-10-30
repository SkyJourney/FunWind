import { ForumTree } from "@/lib/forums/forum-tree";

/**
 * 权限内核的数据契约（纯类型 + 快照构造，无 IO）。设计见 docs/AUTHZ.md §8。
 * 评估器只吃 Subject（谁在做）+ AuthzSnapshot（规则是什么），所以可以脱离数据库单测。
 */

/** 角色绑定：scopeId=0 全局生效；>0 只在该版块子树内生效 */
export interface RoleBinding {
  key: string;
  scopeId: number;
}

/** 当前生效的用户限制（过期与未开始的已在加载时过滤） */
export interface Restriction {
  kind: "ban" | "forum_ban" | "mute" | "no_avatar" | "no_signature";
  /** 0 = 全站；>0 = 版块（含子树） */
  scopeId: number;
  endsAt: string | null;
}

/** 评估主体。userId=null 为游客；显式传入，评估器绝不隐式读取“当前请求用户” */
export interface Subject {
  userId: number | null;
  roles: RoleBinding[];
  restrictions: Restriction[];
  emailVerified: boolean;
  registerMode: "invite" | "open";
}

export interface GrantRow {
  roleKey: string;
  permissionKey: string;
  /** 0 = 全局基线；>0 = 版块（含子树） */
  scopeId: number;
}

/** 规则快照：版块树 + 全部授权行。授权表很小（百行级），整体常驻内存，管理动作后整体失效重建 */
export interface AuthzSnapshot {
  tree: ForumTree;
  grants: readonly GrantRow[];
  grantsByRole: ReadonlyMap<string, readonly GrantRow[]>;
}

export function buildSnapshot(tree: ForumTree, grants: readonly GrantRow[]): AuthzSnapshot {
  const byRole = new Map<string, GrantRow[]>();
  for (const g of grants) {
    const list = byRole.get(g.roleKey) ?? [];
    list.push(g);
    byRole.set(g.roleKey, list);
  }
  return { tree, grants, grantsByRole: byRole };
}

export interface Decision {
  allowed: boolean;
  reason: string;
}

/** 游客的隐式主体 */
export const GUEST_SUBJECT: Subject = {
  userId: null,
  roles: [{ key: "guest", scopeId: 0 }],
  restrictions: [],
  emailVerified: false,
  registerMode: "invite",
};
