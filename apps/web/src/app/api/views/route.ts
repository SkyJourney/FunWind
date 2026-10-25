import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/auth/ratelimit";
import { getCurrentSubject } from "@/lib/authz/subject";
import { clientIpFrom } from "@/lib/net/client-ip";
import { isSameOrigin } from "@/lib/net/same-origin";
import { recordThreadView } from "@/lib/views/record";

/**
 * 浏览量信标（M6.5b，D2）。主题页挂载后由客户端发一次 `POST { tid }`，不在 RSC 渲染路径里计数
 * （预取与 RSC 子请求都会渲染，不能计入）。
 * 对外一律 204：不泄露主题是否存在、是否可见、是否计入。跨站 403；格式错误 400；超限 429。
 */
const bodySchema = z.object({ tid: z.coerce.number().int().positive() });
const IP_PER_MINUTE = 120;
const GLOBAL_PER_MINUTE = 6000;
const WINDOW_MS = 60_000;

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const ip = clientIpFrom(request.headers);
  if (ip !== null && !rateLimit(`views:ip:${ip}`, IP_PER_MINUTE, WINDOW_MS).allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (!rateLimit("views:global", GLOBAL_PER_MINUTE, WINDOW_MS).allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const subject = await getCurrentSubject();
  await recordThreadView({
    subject,
    threadId: parsed.data.tid,
    ip,
    userAgent: request.headers.get("user-agent"),
  });
  return new Response(null, { status: 204 });
}
