import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type z } from "zod";
import { getWebDb } from "@funwind/db";
import { rateLimit } from "@/lib/auth/ratelimit";
import { checkPermission } from "@/lib/authz/service";
import { writeAudit } from "@/lib/audit";
import { authenticateManageRequest } from "@/lib/manage/guard";
import {
  MANAGE_ERROR_CODES,
  ManageApiError,
  manageErrorBody,
  manageOkBody,
  type ManageErrorCode,
} from "@/lib/manage/errors";
import { getManageEndpoint, type ManageEndpointId } from "@/lib/manage/permissions";
import { touchApiTokenUsage, type UsableAdminApiToken } from "@/lib/manage/tokens";
import { clientIpFrom } from "@/lib/net/client-ip";
import type { Subject } from "@/lib/authz/types";
import { enforceManageWriteGate } from "@/lib/manage/write-request";

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
  ip: string | null;
  requestId: string;
  /** Next 动态路由参数（静态路由为已解决的空对象） */
  params: Promise<Record<string, string | string[]>>;
};

export type ManageEndpointOptions = {
  /** 目录中的稳定端点 ID，同时用作调用审计标识。 */
  endpoint: ManageEndpointId;
};

/** 构造统一成功响应（no-store 红线：管理面数据绝不进任何缓存） */
export function manageOk(data: unknown, status = 200): NextResponse {
  const res = NextResponse.json(manageOkBody(data), { status });
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
function toErrorResponse(error: unknown, endpoint: string, requestId?: string): NextResponse {
  if (error instanceof ManageApiError) {
    return manageErrorResponse(error.code, error.retryAfterSec);
  }
  if (error instanceof ZodError) return manageErrorResponse("bad_request");
  // 写路径异常可能携带 SQL 参数；只按请求编号追踪，不写凭证、正文或幂等键。
  if (requestId) console.error(`[manage:${endpoint}] 写处理失败`, { requestId });
  else console.error(`[manage:${endpoint}]`, error);
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
 * 入口封装：方法绑定 → IP 桶 → Bearer 鉴权 → 令牌快照 → 业务权限 → 审计 + last_used → handler。
 * 返回值直接挂到 route 的 HTTP 方法导出上。
 */
export function manageEndpoint(
  handler: (ctx: ManageHandlerContext) => Promise<NextResponse>,
  opts: ManageEndpointOptions,
): (
  request: NextRequest,
  context?: { params: Promise<Record<string, string | string[]>> },
) => Promise<NextResponse> {
  const definition = getManageEndpoint(opts.endpoint);
  return async (request: NextRequest, context) => {
    // Next 可将 HEAD 转发给 GET；未登记的方法不执行处理器或暴露目标状态。
    if (request.method !== definition.method) return manageErrorResponse("not_found");

    const isWrite = definition.access === "write";
    const requestId = randomUUID();
    try {
      const ip = clientIpFrom(request.headers);
      if (ip) {
        const bucket = rateLimit(`manage:ip:${ip}`, IP_RATE_PER_MIN, 60_000);
        if (!bucket.allowed) return manageErrorResponse("rate_limited", bucket.retryAfterSec);
      }
      const { token, subject } = await authenticateManageRequest(request);
      if (!token.endpointGrants.includes(opts.endpoint)) return manageErrorResponse("forbidden");
      if (
        definition.permission &&
        !(await checkPermission(subject, definition.permission)).allowed
      ) {
        return manageErrorResponse("forbidden");
      }
      if (isWrite) enforceManageWriteGate(token);

      // 调用记录只表示通过门禁；写请求不记录原始 query、请求体或幂等键。
      if (definition.audit !== false) {
        await writeAudit(getWebDb(), {
          actorId: token.userId,
          action: `api.${opts.endpoint}`,
          targetType: "manage_api",
          targetId: isWrite ? definition.path : request.nextUrl.pathname,
          after: {
            tokenSuffix: token.suffix,
            via: "api",
            ...(isWrite ? { requestId } : { query: summarizeQuery(request) }),
          },
          ip,
        });
        await touchApiTokenUsage(token.id, ip);
      }
      return await handler({
        request,
        token,
        subject,
        ip,
        requestId,
        params: context?.params ?? Promise.resolve({}),
      });
    } catch (error) {
      return toErrorResponse(error, opts.endpoint, isWrite ? requestId : undefined);
    }
  };
}

/**
 * 日志类端点工厂（M20）：emails / push-logs 同构（分页 + 成败摘要 + admin.logs 权限），
 * 参数 schema 与查询函数由调用方注入，入口封装与信封复用一份实现。
 */
export function manageLogEndpoint<S extends z.ZodType>(cfg: {
  endpoint: "emails" | "push-logs";
  schema: S;
  query: (q: z.infer<S>) => Promise<{ items: unknown[]; total: number }>;
  summary?: () => Promise<Record<string, number>>;
}): (request: NextRequest) => Promise<NextResponse> {
  return manageEndpoint(
    async ({ request }) => {
      const q = parseManageQuery(request, cfg.schema);
      const [logs, summary] = await Promise.all([
        cfg.query(q),
        cfg.summary ? cfg.summary() : Promise.resolve(undefined),
      ]);
      return manageOk(summary ? { ...logs, summary } : logs);
    },
    { endpoint: cfg.endpoint },
  );
}
