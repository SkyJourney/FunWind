import "server-only";

import type { NextRequest } from "next/server";
import { hashToken } from "@/lib/auth/token";
import { rateLimit } from "@/lib/auth/ratelimit";
import { checkPermission } from "@/lib/authz/service";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { ManageApiError } from "@/lib/manage/errors";
import {
  manageTokenProfileOf,
  resolveUsableApiToken,
  type UsableAdminApiToken,
} from "@/lib/manage/tokens";

/**
 * 管理 REST API 的 Bearer 门禁（M20）。JSON 语义，绝不复用 requireAdmin/requireModerator
 * （二者是 redirect/notFound 的页面语义）。
 *
 * 管理员资格判定 = checkPermission(site.admin) && checkPermission(admin.roles)
 * ——站点管理员不变量（site-admin-invariant）的权限核心在评估器上的实时对偶；
 * 可登录 / 未封禁 / 未注销由 loadSubject 的 GUEST 回落与评估器覆盖。
 * 联动吊销是第一道防线（D4，事务内），本门禁实时校验是第二道。
 */

/** per-token 频控（次/分钟）：管理 API 是低频脚本场景，60/min 足够 */
export const TOKEN_RATE_PER_MIN = 60;

/**
 * 严格解析 Authorization 头：仅接受历史和细粒度两种前缀，错误格式一律返回 null。
 */
export function parseBearerToken(header: string | null): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length);
  return manageTokenProfileOf(value) ? value : null;
}

export type ManageIdentity = {
  token: UsableAdminApiToken;
  /** 持有人主体（实时加载且已判非游客；撤权/封禁即失权的第二道防线） */
  subject: Subject;
};

/**
 * 鉴权链（IP 桶在入口封装 manageEndpoint 之前做）：
 * 解析 Bearer → per-token 桶（对同一 token 明文限速，防穷举/滥用）→ 查行 → loadSubject → 资格。
 * 任一步失败抛 ManageApiError（401/403），由入口封装转统一信封。
 */
export async function authenticateManageRequest(request: NextRequest): Promise<ManageIdentity> {
  const plain = parseBearerToken(request.headers.get("authorization"));
  if (!plain) throw new ManageApiError("unauthorized");

  // 桶 key 用全哈希：对同一 token 的请求限速（含已失效 token 的穷举重放）；全哈希避免前缀碰撞共享桶
  const tokenBucketKey = `manage:token:${hashToken(plain)}`;
  const bucket = rateLimit(tokenBucketKey, TOKEN_RATE_PER_MIN, 60_000);
  if (!bucket.allowed) throw new ManageApiError("rate_limited", bucket.retryAfterSec);

  const token = await resolveUsableApiToken(plain);
  if (!token) throw new ManageApiError("unauthorized");

  const subject = await loadSubject(token.userId);
  if (subject.userId === null) throw new ManageApiError("unauthorized");

  // 资格 = 不变量双持权限核心；任一缺失（撤权/封禁/角色过期）→ 403
  const [asSiteAdmin, asRoleAdmin] = await Promise.all([
    checkPermission(subject, "site.admin"),
    checkPermission(subject, "admin.roles"),
  ]);
  if (!asSiteAdmin.allowed || !asRoleAdmin.allowed) throw new ManageApiError("forbidden");

  return { token, subject };
}
