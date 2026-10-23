import { permissionSatisfies } from "@funwind/db";

/**
 * 权限评估器（M5，纯函数）：admin 短路 → muted 拦截 → 作用域授权（级别隐含）→ 默认拒绝。
 * IO（角色/授权装载、作用域链解析、React cache）在 service.ts；本文件可穷举单测。
 */

export interface GrantRow {
  roleKey: string;
  permissionKey: string;
}

export interface EvaluateInput {
  /** 用户全部有效角色键（隐式 member/guest + user_roles 绑定，过期项已由装载层过滤） */
  roleKeys: readonly string[];
  /** 全局禁言生效（user_bans/muted 绑定由装载层判定） */
  mutedActive: boolean;
  /** 用户角色在作用域链上的全部有效授权 */
  grants: readonly GrantRow[];
  permissionKey: string;
}

export interface EvaluateResult {
  allowed: boolean;
  reason: string;
}

export const BUILTIN = {
  GUEST: "guest",
  MEMBER: "member",
  MUTED: "muted",
  ADMIN: "admin",
} as const;

/** muted 禁言封堵的权限：发帖/回帖/附件上传/私信（浏览不受限） */
export function isMutedBlocked(permissionKey: string): boolean {
  return (
    permissionKey === "forum.write" ||
    permissionKey.startsWith("thread.") ||
    permissionKey === "pm.send" ||
    permissionKey === "attachment.upload"
  );
}

export function evaluate(input: EvaluateInput): EvaluateResult {
  const roles = input.roleKeys;

  // 1. admin 短路
  if (roles.includes(BUILTIN.ADMIN)) {
    return { allowed: true, reason: "admin" };
  }

  // 2. muted：禁言优先于任何授权
  if (input.mutedActive && isMutedBlocked(input.permissionKey)) {
    return { allowed: false, reason: "账号处于禁言状态" };
  }

  // 3. 授权匹配（级别隐含由 permissionSatisfies 判定；forumId 已由装载层按作用域链过滤）
  let matched = false;
  for (const g of input.grants) {
    if (!roles.includes(g.roleKey)) continue;
    if (permissionSatisfies(g.permissionKey, input.permissionKey)) {
      matched = true;
      break;
    }
  }
  if (matched) return { allowed: true, reason: "授权" };

  return { allowed: false, reason: "默认拒绝" };
}
