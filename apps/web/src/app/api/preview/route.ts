import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/auth/ratelimit";
import { clientIpFrom } from "@/lib/net/client-ip";
import { previewHtml } from "@/lib/posting/preview";

/**
 * 编辑器预览（M6.3 §5）。POST JSON `{ source }`，返回站点渲染器输出的净化 HTML。
 * - 不读库、不写库：只渲染请求体里的文本；门控正文不出现在结果里（见 lib/posting/preview.ts）；
 * - 同源检查：Origin 存在且与本站不一致 → 403（POST 的跨站提交拿不到结果，但仍不接受）；
 * - 限流：按可信 IP 限制渲染次数（渲染有 CPU 成本）；超限 429。
 * 不走 defineAction：它的返回值约定是 void，而预览需要返回 HTML。
 */
const bodySchema = z.object({ source: z.string().max(200_000) });

const PREVIEW_MAX = 60;
const PREVIEW_WINDOW_MS = 60_000;

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ip = clientIpFrom(request.headers);
  if (ip !== null && !rateLimit(`preview:${ip}`, PREVIEW_MAX, PREVIEW_WINDOW_MS).allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  return NextResponse.json({ html: previewHtml(parsed.data.source) });
}
