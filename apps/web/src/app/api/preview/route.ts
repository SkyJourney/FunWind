import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit, rateLimitRefund } from "@/lib/auth/ratelimit";
import { getCurrentUser } from "@/lib/auth/session";
import { readBodyBytes } from "@/lib/net/read-body";
import { isSameOrigin } from "@/lib/net/same-origin";
import { previewHtml } from "@/lib/posting/preview";

/**
 * 编辑器预览（M6.3 §5）。POST JSON `{ source }`，返回站点渲染器输出的净化 HTML。
 * - 不读库、不写库：只渲染请求体里的文本；门控正文不出现在结果里（见 lib/posting/preview.ts）；
 * - 同源检查：Origin 存在且与本站不一致 → 403（POST 的跨站提交拿不到结果，但仍不接受）；
 * - 必须登录：编辑器只对登录用户开放，游客无需也拿不到渲染能力（401）；
 * - 限流：先过全局总量桶（不依赖可信 IP，取不到 IP 时也有上限），再过每用户桶；超限 429；
 * - 字节上限：流式计数，超出 413（分块传输无法靠 Content-Length 拦住）；
 * - 渲染不进共享缓存（见 previewHtml）。
 * 不走 defineAction：它的返回值约定是 void，而预览需要返回 HTML。
 */
const bodySchema = z.object({ source: z.string().max(200_000) });

/** 请求体字节上限：20 万字符的 UTF-8 最多约 80 万字节，再留余量给 JSON 结构 */
const BODY_MAX_BYTES = 900_000;
const USER_PER_MINUTE = 60;
const GLOBAL_PER_MINUTE = 600;
const WINDOW_MS = 60_000;

function json(body: unknown, status: number): Response {
  return NextResponse.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);

  const user = await getCurrentUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  // 先每用户、后全局：被用户桶拒绝的请求不占全局额度，单个用户无法耗尽全站的预览额度（审查复查）。
  // 全局桶拒绝时退还刚占用的用户额度，避免全站拥堵时把用户自己的额度也烧掉。
  const userKey = `preview:user:${user.id}`;
  if (!rateLimit(userKey, USER_PER_MINUTE, WINDOW_MS).allowed) {
    return json({ error: "rate_limited" }, 429);
  }
  if (!rateLimit("preview:global", GLOBAL_PER_MINUTE, WINDOW_MS).allowed) {
    rateLimitRefund(userKey);
    return json({ error: "rate_limited" }, 429);
  }

  const bytes = await readBodyBytes(request, BODY_MAX_BYTES);
  if (bytes === null) return json({ error: "too_large" }, 413);
  const text = bytes.toString("utf8");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const parsed = bodySchema.safeParse(parsedJson);
  if (!parsed.success) return json({ error: "bad_request" }, 400);

  return json({ html: previewHtml(parsed.data.source) }, 200);
}
