import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type z } from "zod";
import { getWebDb } from "@funwind/db";
import { rateLimit } from "@/lib/auth/ratelimit";
import { checkPermission } from "@/lib/authz/service";
import { writeAudit } from "@/lib/audit";
import { authenticateManageRequest, type ManageIdentity } from "@/lib/manage/guard";
import {
  MANAGE_ERROR_CODES,
  ManageApiError,
  manageErrorBody,
  manageOkBody,
  type ManageErrorCode,
} from "@/lib/manage/errors";
import { touchApiTokenUsage, type UsableAdminApiToken } from "@/lib/manage/tokens";
import { clientIpFrom } from "@/lib/net/client-ip";
import type { Subject } from "@/lib/authz/types";

/**
 * 管理 REST API 的入口封装（M20 分层纪律的唯一入口工具）：
 * route.ts = `export const GET = manageEndpoint(handler, opts)`，
 * handler 里只允许「zod 解析 → 调 Service → manageOk」三件事；
 * 鉴权、频控、审计、last_used、信封、兜底全在这里（业务语义仍在 Service，本文件零业务逻辑）。
 */

/** IP 桶（次/分钟）：在解析凭证之前拦，防暴力穷举 */
const IP_RATE_PER_MIN = 120;

/** after_json 里 query 摘要的截断上限（防超长 query 撑爆审计行） */
const AUDIT_QUERY_MAX_CHARS = 512;

export type ManageHandlerContext = {
  request: NextRequest;
  /** 已通过鉴权的 token（哈希 id / 尾号 / 持有人） */
  token: UsableAdminApiToken;
  /** 持有人主体（实时加载，已判非游客） */
  subject: Subject;
  /** Next 动态路由参数（静态路由为已解决的空对象） */
  params: Promise<Record<string, string | string[]>>;
};

export type ManageEndpointOptions = {
  /** 审计 action 名（action = `api.<endpoint>`，如 "stats"） */
  endpoint: string;
  /** 端点业务权限点（管理员资格之外的第二层，如 "admin.logs"）；缺省仅要求资格 */
  permission?: string;
  /** 是否写调用审计（whoami 握手高频无信息量，传 false 跳过；缺省 true） */
  audit?: boolean;
};

/** 构造统一成功响应（no-store 红线：管理面数据绝不进任何缓存） */
export function manageOk(data: unknown): NextResponse {
  const res = NextResponse.json(manageOkBody(data));
  res.headers.set("cache-control", "private, no-store");
  return res;
}

/** 构造统一错误响应：码经注册表查状态与文案，429 附 Retry-After */
export function manageErrorResponse(code: ManageErrorCode, retryAfterSec?: number): NextResponse {
  const res = NextResponse.json(manageErrorBody(code), { status: MANAGE_ERROR_CODES[code].status });
  res.headers.set("cache-control", "private, no-store");
  if (retryAfterSec !== undefined) res.headers.set("retry-after", String(retryAfterSec));
  return res;
}

/** 统一异常 → 信封：ManageApiError 直转；zod 校验失败按 bad_request；其余兜底 internal（不透传细节） */
function toErrorResponse(error: unknown, endpoint: string): NextResponse {
  if (error instanceof ManageApiError) {
    return manageErrorResponse(error.code, error.retryAfterSec);
  }
  if (error instanceof ZodError) return manageErrorResponse("bad_request");
  console.error(`[manage:${endpoint}]`, error);
  return manageErrorResponse("internal");
}

/**
 * GET 参数解析：zod schema 校验 searchParams，失败抛 ManageApiError("bad_request")。
 * v1 语义明确：非法参数不静默回落（与页面 GET 表单的宽容策略有意区分——API 的消费方是程序）。
 */
export function parseManageQuery<S extends z.ZodType>(request: NextRequest, schema: S): z.infer<S> {
  const raw = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ManageApiError("bad_request");
  return parsed.data;
}

/** query 摘要：键值对 JSON 化并截断（审计观测用，不承载业务语义） */
function summarizeQuery(request: NextRequest): string {
  const json = JSON.stringify(Object.fromEntries(request.nextUrl.searchParams));
  return json.length > AUDIT_QUERY_MAX_CHARS ? json.slice(0, AUDIT_QUERY_MAX_CHARS) : json;
}

/**
 * 入口封装：IP 桶 → Bearer 鉴权（token 桶内嵌）→ 业务权限 → 审计 + last_used → handler → 信封。
 * 返回值直接挂到 route 的 HTTP 方法导出上。
 */
export function manageEndpoint(
  handler: (ctx: ManageHandlerContext) => Promise<NextResponse>,
  opts: ManageEndpointOptions,
): (
  request: NextRequest,
  context?: { params: Promise<Record<string, string | string[]>> },
) => Promise<NextResponse> {
  return async (request: NextRequest, context) => {
    // 1. IP 桶：凭证解析之前先限来源（取不到可信 IP 跳过，只靠 token 桶）
    const ip = clientIpOf(request);
    if (ip) {
      const bucket = rateLimit(`manage:ip:${ip}`, IP_RATE_PER_MIN, 60_000);
      if (!bucket.allowed) return manageErrorResponse("rate_limited", bucket.retryAfterSec);
    }

    // 2. Bearer 鉴权（token 桶 / 查行 / loadSubject / 管理员资格都在 authenticate 内）
    let identity: ManageIdentity;
    try {
      identity = await authenticateManageRequest(request);
    } catch (error) {
      return toErrorResponse(error, opts.endpoint);
    }

    // 3. 端点业务权限（资格已过；缺权限点 → 403）
    if (opts.permission) {
      const decision = await checkPermission(identity.subject, opts.permission);
      if (!decision.allowed) return manageErrorResponse("forbidden");
    }

    // 4. 调用审计 + last_used 节流（资格通过即记；whoami 握手跳过）
    if (opts.audit !== false) {
      await writeAudit(getWebDb(), {
        actorId: identity.token.userId,
        action: `api.${opts.endpoint}`,
        targetType: "manage_api",
        targetId: request.nextUrl.pathname,
        after: { query: summarizeQuery(request), tokenSuffix: identity.token.suffix },
        ip,
      });
      await touchApiTokenUsage(identity.token.id, ip);
    }

    // 5. handler（Service 调用 + zod 解析）与兜底
    try {
      return await handler({
        request,
        token: identity.token,
        subject: identity.subject,
        params: context?.params ?? Promise.resolve({}),
      });
    } catch (error) {
      return toErrorResponse(error, opts.endpoint);
    }
  };
}

/** clientIpFrom 包装：生产必须显式 TRUSTED_PROXY_HOPS（缺失直接抛，行为与全站一致） */
function clientIpOf(request: NextRequest): string | null {
  return clientIpFrom(request.headers);
}
