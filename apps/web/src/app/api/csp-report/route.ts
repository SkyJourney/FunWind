import { clientIpFrom } from "@/lib/net/client-ip";
import { rateLimit } from "@/lib/auth/ratelimit";

/**
 * CSP 违规报告收集（M5.6 S4）。浏览器对 Report-Only 策略的违规会 POST 到这里。
 * 公开端点，所以：流式体积上限、URI 脱敏（去掉令牌与查询串）、逐字段截断并剔除控制字符（防日志注入）、频控、永远 204（不泄露任何状态）。
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

/**
 * CSP 报告里的 URI 字段（document-uri / blocked-uri / source-file）会带页面完整地址——包括
 * `/reset/<令牌>`、`/claim/<令牌>`、`/verify/<令牌>`（单次使用的密码重置 / 认领 / 验证令牌）和查询串。
 * 原样写进日志等于把这些令牌发给能读日志的人，所以只保留「源 + 规范化路径」：
 *  · 去掉查询串与片段；
 *  · 路径里看起来像不透明令牌 / 哈希的段（≥20 个 URL-safe 字符，可带扩展名）换成 `:token`；
 *  · 非 http(s) 的 URL 只留协议（`data:`、`blob:` 的内容可能很长且含数据）；
 *  · 既不是 URL 也不是 CSP 关键字（inline / eval …）的值一律记为 `[other]`。
 */
const CSP_KEYWORDS = new Set([
  "inline",
  "eval",
  "wasm-eval",
  "self",
  "data",
  "blob",
  "about",
  "trusted-types-sink",
]);
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{20,}(\.[A-Za-z0-9]{1,8})?$/;

export function redactUri(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (CSP_KEYWORDS.has(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "[other]";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol;
  const path = url.pathname
    .split("/")
    .map((seg) => (OPAQUE_SEGMENT.test(seg) ? ":token" : seg))
    .join("/");
  return `${url.origin}${path}`.slice(0, 200);
}

const URI_FIELDS = new Set(["blocked-uri", "document-uri", "source-file"]);

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
      if (v !== undefined) row[f] = URI_FIELDS.has(f) ? redactUri(v) : clean(v);
    }
    if (Object.keys(row).length > 0) out.push(row);
  }
  return out;
}

/**
 * 按字节上限流式读取请求体：超过上限立即取消读取并返回 null。
 * 只检查 Content-Length 不够——分块传输（chunked）或不带该头的请求会被 `req.text()` 整个读进内存。
 */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: Request) {
  const done = new Response(null, { status: 204 });
  const ip = clientIpFrom(req.headers);
  // 每个 IP（取不到时共用一个桶）每分钟最多处理 30 份；超出静默丢弃，不能让这个端点变成刷日志的入口
  if (!rateLimit(`csp-report:${ip ?? "-"}`, 30, 60_000).allowed) return done;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return done; // 快速拒绝；真正的上限由下面的流式读取保证
  try {
    const text = await readCapped(req, MAX_BODY);
    if (text === null) return done;
    for (const row of extractReports(JSON.parse(text))) {
      console.warn(`[csp-report] ${JSON.stringify(row)}`);
    }
  } catch {
    // 畸形报告直接忽略
  }
  return done;
}
