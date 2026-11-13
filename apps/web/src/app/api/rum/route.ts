import { rateLimit, rateLimitRefund } from "@/lib/auth/ratelimit";
import { clientIpFrom } from "@/lib/net/client-ip";
import { readBodyBytes } from "@/lib/net/read-body";
import { isSameOrigin } from "@/lib/net/same-origin";
import { recordRumSamples } from "@/lib/rum/ingest";
import { rumPayloadSchema } from "@/lib/rum/schema";
import { redactUri } from "../csp-report/route";

/**
 * 真实用户监测上报（M17 Step 4）。浏览器侧把 Core Web Vitals 与前端错误采样 POST 到这里。
 *
 * **对外一律 204**（照 csp-report）：这是 fire-and-forget 信标，客户端不消费响应；
 * 不泄露「是否被限流 / 是否落库 / 格式是否合法」，也不给探测者任何信号。
 * 处理顺序照 views 信标：同源 → 廉价限流（内存内）→ 有上限读体 → 校验 → 脱敏 → 落库。
 * 限流先于读体，超限请求不付出解析成本。
 *
 * 隐私：route 经 redactUri（令牌段 → :token、去查询串与片段）；detail 去控制字符并截断；
 * **IP 只作频控键，不落库**；不存 UA、不存堆栈、不存任何可识别个人的字段。
 */
const BODY_MAX_BYTES = 8192;
const IP_PER_MINUTE = 60;
const GLOBAL_PER_MINUTE = 3000;
const WINDOW_MS = 60_000;
const DETAIL_MAX = 200;

/**
 * redactUri 内部是 `new URL(raw)`，**裸路径会抛异常并返回 "[other]"**——直接传 pathname
 * 会把所有 route 静默变成 [other]。所以先用固定 base 拼成合法 URL 再脱敏，然后剥掉 base：
 * 既保证脱敏生效，又让存库 route 是纯路径，且客户端无法注入任意 origin。
 */
const ROUTE_BASE = "https://rum.invalid";

const done = () => new Response(null, { status: 204 });

const redactRoute = (path: string): string => {
  // 只接受站内绝对路径：必须以单个 / 开头。拒掉完整 URL（客户端若传 https://evil.test/x，
  // 拼 base 后会变成 /https://evil.test/x，外站域名被当路径存下来污染 route 维度）、
  // 协议相对 URL（//evil.test）与相对片段。
  if (!path.startsWith("/") || path.startsWith("//")) return "[other]";
  const out = redactUri(`${ROUTE_BASE}${path}`);
  return out.startsWith(ROUTE_BASE) ? out.slice(ROUTE_BASE.length) : "[other]";
};

/** 控制字符一律换空格（防日志/存储注入），再截断 */
const cleanDetail = (v: string): string => v.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, DETAIL_MAX);

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return done();

  // 拿不到可信 IP 时共用 unknown 桶：不信任可伪造的头，也不让它们绕过 IP 级限额
  const ip = clientIpFrom(request.headers);
  const ipKey = `rum:ip:${ip ?? "unknown"}`;
  if (!rateLimit(ipKey, IP_PER_MINUTE, WINDOW_MS).allowed) return done();
  if (!rateLimit("rum:global", GLOBAL_PER_MINUTE, WINDOW_MS).allowed) {
    rateLimitRefund(ipKey);
    return done();
  }

  const bytes = await readBodyBytes(request, BODY_MAX_BYTES);
  if (bytes === null) return done();
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return done();
  }
  const parsed = rumPayloadSchema.safeParse(json);
  if (!parsed.success) return done();

  const rows = parsed.data.samples.map((s) => ({
    kind: s.kind,
    name: s.name,
    value: s.value,
    route: redactRoute(s.route),
    detail: s.kind === "error" && s.detail !== undefined ? cleanDetail(s.detail) : null,
  }));

  // 落库失败不反噬：观测数据丢一批可以接受，不能让上报端点成为故障源
  try {
    await recordRumSamples(rows);
  } catch {
    // 静默：错误细节由数据库层日志承载，不回传给客户端
  }
  return done();
}
