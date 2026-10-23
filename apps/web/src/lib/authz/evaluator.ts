import { permissionSatisfies } from "@funwind/db";

/**
 * 权限评估器（M5，纯函数）。
 * 语义（见 docs/AUTHZ.md）：
 *  1. admin 内置角色 → 短路 ALLOW
 *  2. muted（禁言）→ 发帖类权限 DENY（优先于授权）
 *  3. 作用域链（forum → 父链）分两种语义：
 *     - 读类（forum.read）：**显式优先**——链上最近一「有该权限点配置」的层说了算，不再回退父级。
 *       （旧站 allow_read 是每版块独立白名单；若无回退，父级公开读会击穿子级受限版块）
 *     - 管理类（forum.write/manage）：**级联合并**——任一层命中即生效。
 *       （新设计：子版块自动带父版块版主的能力）
 *     - 链上完全无配置 → 走默认策略（读=游客可读；写=注册用户）
 */

export interface GrantRow {
  roleKey: string;
  permissionKey: string;
  /** 作用域层级：0=目标版块，1=父级…，末层=全局；用于就近优先判定 */
  layer: number;
  /** 作用域类型：forum=版块显式配置，global=全局基线 */
  scopeType: "forum" | "global";
}

export interface EvaluateInput {
  /** 用户全部有效角色键（隐式 member/guest + user_roles 绑定，过期已过滤） */
  roleKeys: readonly string[];
  /** 全局禁言生效 */
  mutedActive: boolean;
  /** 用户角色在作用域链上的全部有效授权（按角色键直查 role_grants） */
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

/** 读类权限：显式优先（就近层判定，不回退父级） */
export function isStrictScope(permissionKey: string): boolean {
  return permissionKey === "forum.read";
}

/** 默认策略（链上无任何配置时）：游客可读，注册用户可写 */
function defaultAllowed(permissionKey: string, roleKeys: readonly string[]): boolean {
  if (permissionKey === "forum.read" || permissionKey === "site.visit") return true;
  if (permissionKey === "forum.write") return roleKeys.includes(BUILTIN.MEMBER);
  return false;
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

  // 3. 授权匹配
  const mine = input.grants.filter((g) => roles.includes(g.roleKey));
  const exact = mine.filter((g) => g.permissionKey === input.permissionKey);
  const satisfying = mine.filter((g) => permissionSatisfies(g.permissionKey, input.permissionKey));

  if (isStrictScope(input.permissionKey)) {
    // 显式优先：链上「任何角色」在【版块作用域】对该权限点有配置的最浅层 → 只在该层判定
    // （全局行是基线兜底，不参与就近层锚定——否则 admin 的全局授权会掩盖子版块的显式限制）
    const forumLayers = [
      ...new Set(
        input.grants
          .filter((g) => g.permissionKey === input.permissionKey && g.scopeType === "forum")
          .map((g) => g.layer),
      ),
    ];
    if (forumLayers.length === 0) {
      // 无版块级配置 → 回退全局层，再退默认策略
      const globalHit = exact.find((g) => g.scopeType === "global");
      if (globalHit) return { allowed: true, reason: "授权（全局基线）" };
      return defaultAllowed(input.permissionKey, roles)
        ? { allowed: true, reason: "默认策略" }
        : { allowed: false, reason: "默认拒绝" };
    }
    const nearest = Math.min(...forumLayers);
    if (exact.some((g) => g.layer === nearest && g.scopeType === "forum")) {
      return { allowed: true, reason: "授权" };
    }
    return { allowed: false, reason: "该版块显式限制（就近层不匹配）" };
  }

  // 级联合并：任一层命中即允许（版主继承语义）
  if (exact.length > 0) return { allowed: true, reason: "授权" };
  if (satisfying.length > 0) return { allowed: true, reason: "授权（级别隐含）" };

  if (defaultAllowed(input.permissionKey, roles)) {
    return { allowed: true, reason: "默认策略" };
  }
  return { allowed: false, reason: "默认拒绝" };
}
