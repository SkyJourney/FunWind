import { NextResponse } from "next/server";
import { rateLimit, rateLimitRefund } from "@/lib/auth/ratelimit";
import { clientIpFrom } from "@/lib/net/client-ip";
import type { StreamPage } from "./page";

/**
 * 流式取数端点的共用响应与限流（M10.7）。
 * 端点只读、允许游客，权限由各端点的查询层（取数前可见性过滤）负责；这里只管：
 * - 限流：先每 IP、后全局（被 IP 桶拒绝的请求不占全局额度；全局桶拒绝时退还 IP 额度）。
 *   拿不到可信 IP 时共用 `unknown` 桶，不信任 User-Agent 等可伪造的头（同 /api/views）；
 * - 响应：按访客身份得出的内容绝不进共享缓存（`private, no-store`）。
 */
const IP_PER_MINUTE = 120;
const GLOBAL_PER_MINUTE = 6000;
const WINDOW_MS = 60_000;

/** 限流通过返回 null，超限返回 429 响应 */
export function streamRateLimit(request: Request): Response | null {
  const ip = clientIpFrom(request.headers);
  const ipKey = `stream:ip:${ip ?? "unknown"}`;
  if (!rateLimit(ipKey, IP_PER_MINUTE, WINDOW_MS).allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (!rateLimit("stream:global", GLOBAL_PER_MINUTE, WINDOW_MS).allowed) {
    rateLimitRefund(ipKey);
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  return null;
}

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export function streamJson<T>(body: StreamPage<T>): Response {
  return NextResponse.json(body, { status: 200, headers: NO_STORE });
}

/** 越权与不存在一律 404（硬约定 7：不暴露受限板块的存在） */
export function streamNotFound(): Response {
  return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
}
