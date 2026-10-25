import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit, rateLimitRefund } from "@/lib/auth/ratelimit";
import { getCurrentSubject } from "@/lib/authz/subject";
import { clientIpFrom } from "@/lib/net/client-ip";
import { readBodyBytes } from "@/lib/net/read-body";
import { isSameOrigin } from "@/lib/net/same-origin";
import { recordThreadView } from "@/lib/views/record";

/**
 * 浏览量信标（M6.5b，D2）。主题页挂载后由客户端发一次 `POST { tid }`，不在 RSC 渲染路径里计数
 * （预取与 RSC 子请求都会渲染，不能计入）。
 * 对外一律 204：不泄露主题是否存在、是否可见、是否计入。跨站 403；格式错误 400；超限 429。
 * 处理顺序：同源 → 限流（廉价、内存内）→ 读体（有上限）→ 会话 → 记录。限流先于读体，超限请求不付出解析成本。
 */
const bodySchema = z.object({ tid: z.coerce.number().int().positive() });
const BODY_MAX_BYTES = 1024;
const IP_PER_MINUTE = 120;
const GLOBAL_PER_MINUTE = 6000;
const WINDOW_MS = 60_000;

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // 拿不到可信 IP 的请求共用 `unknown` 桶：不信任 User-Agent 等可伪造的头，也不让它们绕过 IP 级限额
  const ip = clientIpFrom(request.headers);
  const ipKey = `views:ip:${ip ?? "unknown"}`;
  if (!rateLimit(ipKey, IP_PER_MINUTE, WINDOW_MS).allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (!rateLimit("views:global", GLOBAL_PER_MINUTE, WINDOW_MS).allowed) {
    rateLimitRefund(ipKey);
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // 请求体是一个很小的 JSON；超过上限（含分块传输）一律按格式错误处理，不整包读进内存
  const bytes = await readBodyBytes(request, BODY_MAX_BYTES);
  if (bytes === null) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const subject = await getCurrentSubject();
  // 登录用户再按账号限额：换 IP 也不能无限刷（会话查询放在前两道廉价限额之后，防止未限额的请求压垮数据库）
  if (
    subject.userId !== null &&
    !rateLimit(`views:user:${subject.userId}`, IP_PER_MINUTE, WINDOW_MS).allowed
  ) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  await recordThreadView({ subject, threadId: parsed.data.tid, ip });
  return new Response(null, { status: 204 });
}
