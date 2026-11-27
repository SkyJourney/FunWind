import "server-only";

import { createHash } from "node:crypto";
import { loadFeed, type FeedScope } from "./query";
import { renderFeed, type FeedFormat } from "./render";
import { getFeedSiteIdentity } from "./urls";

const CACHE_CONTROL = "public, no-cache";
const ERROR_MESSAGES = {
  400: "订阅格式无效",
  404: "未找到订阅源",
  503: "订阅源暂不可用",
} as const;

function handleError(request: Request, status: keyof typeof ERROR_MESSAGES): Response {
  return new Response(request.method === "HEAD" ? null : ERROR_MESSAGES[status], {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}

function getFormat(url: string): FeedFormat | null {
  const formats = new URL(url).searchParams.getAll("format");
  if (formats.length === 0) return "rss";
  if (formats.length !== 1) return null;
  const [format] = formats;
  return format === "rss" || format === "atom" ? format : null;
}

/** GET 和 HEAD 使用弱比较。实体标签可包含逗号，须逐个匹配完整标签。 */
function matchesIfNoneMatch(value: string | null, etag: string): boolean {
  if (value === null) return false;
  if (value.trim() === "*") return true;
  const tokens = /[ \t]*(?:(?:W\/)?("[!\x23-\x7E\x80-\xFF]*")[ \t]*)?(?:,|$)/gy;
  let matched = false;
  while (tokens.lastIndex < value.length) {
    const token = tokens.exec(value);
    if (!token) return false;
    if (token[1] === etag) matched = true;
  }
  return matched;
}

/** 版块路由仅接受正的十进制 ID；无效标识和无权读取均返回相同的 404。 */
export function forumFeedScope(raw: string): FeedScope | null {
  if (!/^\d+$/.test(raw)) return null;
  const fid = Number(raw);
  return Number.isSafeInteger(fid) && fid > 0 ? { kind: "forum", fid } : null;
}

/** 每次重验证都先读取新鲜的游客权限及内容，错误时不返回任何旧表示或验证器。 */
export async function respondToFeed(request: Request, scope: FeedScope | null): Promise<Response> {
  if (scope === null) return handleError(request, 404);
  const format = getFormat(request.url);
  if (format === null) return handleError(request, 400);

  try {
    const data = await loadFeed(scope);
    if (data === null) return handleError(request, 404);
    const site = await getFeedSiteIdentity();
    const body = renderFeed(format, site, scope, data);
    const etag = `"${createHash("sha256").update(body, "utf8").digest("hex")}"`;
    const headers = { "cache-control": CACHE_CONTROL, etag };
    if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === "HEAD" ? null : body, {
      headers: { ...headers, "content-type": `application/${format}+xml; charset=utf-8` },
    });
  } catch {
    return handleError(request, 503);
  }
}
