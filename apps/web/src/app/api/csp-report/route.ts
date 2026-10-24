import { clientIpFrom } from "@/lib/net/client-ip";
import { rateLimit } from "@/lib/auth/ratelimit";

/**
 * CSP 违规报告收集（M5.6 S4）。浏览器对 Report-Only 策略的违规会 POST 到这里。
 * 公开端点，所以：体积上限、逐字段截断并剔除控制字符（防日志注入）、频控、永远 204（不泄露任何状态）。
 * 只记一行日志，不落库。想看报告：grep 服务日志里的 `[csp-report]`。
 */

const MAX_BODY = 16 * 1024;
const FIELDS = [
  "violated-directive",
  "effective-directive",
  "blocked-uri",
  "document-uri",
  "source-file",
  "line-number",
  "disposition",
] as const;

/** 控制字符一律去掉，长度截断；日志里只会是单行 */
const clean = (v: unknown) =>
  String(v ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 200);

/** 兼容两种格式：旧的 {"csp-report": {...}}（application/csp-report）与 Reporting API 的 [{type, body}]（application/reports+json） */
export function extractReports(payload: unknown): Record<string, string>[] {
  const items = Array.isArray(payload) ? payload : [payload];
  const out: Record<string, string>[] = [];
  for (const item of items.slice(0, 10)) {
    const obj = item as { "csp-report"?: Record<string, unknown>; body?: Record<string, unknown> };
    const r = obj?.["csp-report"] ?? obj?.body;
    if (!r || typeof r !== "object") continue;
    const row: Record<string, string> = {};
    for (const f of FIELDS) {
      // Reporting API 用驼峰（violatedDirective），旧格式用连字符
      const camel = f.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      const v = r[f] ?? r[camel];
      if (v !== undefined) row[f] = clean(v);
    }
    if (Object.keys(row).length > 0) out.push(row);
  }
  return out;
}

export async function POST(req: Request) {
  const done = new Response(null, { status: 204 });
  const ip = clientIpFrom(req.headers);
  // 每个 IP（取不到时共用一个桶）每分钟最多处理 30 份；超出静默丢弃，不能让这个端点变成刷日志的入口
  if (!rateLimit(`csp-report:${ip ?? "-"}`, 30, 60_000).allowed) return done;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return done;
  try {
    const text = (await req.text()).slice(0, MAX_BODY);
    for (const row of extractReports(JSON.parse(text))) {
      console.warn(`[csp-report] ${JSON.stringify(row)}`);
    }
  } catch {
    // 畸形报告直接忽略
  }
  return done;
}
