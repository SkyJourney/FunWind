/**
 * 流式加载（M10.7）共用的分页契约与参数解析。
 * 取数端点（app/api/stream/**）与客户端追加组件（components/stream）都依赖本文件，保持纯函数、零依赖。
 */

/**
 * 取数端点的统一响应：本页条目 + 是否还有下一页 + 本页页码。
 * 游标分页的端点（通知）另带 `nextCursor`：下一次请求要带的游标，此时 `page` 无意义（固定 0）。
 */
export interface StreamPage<T> {
  items: T[];
  hasMore: boolean;
  page: number;
  nextCursor?: string | null;
}

/**
 * 页码上限：页码最终变成 `OFFSET (page-1) * 每页条数`，不设上限时游客可以构造极深偏移拖慢数据库。
 * 500 页 × 每页 20 条已远超任何真实浏览深度。
 */
export const MAX_STREAM_PAGE = 500;

/** 把 `?page=` 收束成 [1, MAX_STREAM_PAGE] 内的整数；非数字、小数、负数、Infinity 都不会产生 500 */
export function parseStreamPage(raw: string | null | undefined): number {
  const whole = Math.trunc(Number(raw)) || 1;
  return Math.min(Math.max(1, whole), MAX_STREAM_PAGE);
}

/** 解析正整数查询参数（分区 / 前缀 id 等）；缺省或非法返回 undefined */
export function parsePositiveInt(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 在基础路径（可能已带查询串）后追加 `name=value`，供取数地址与兜底链接共用（值会做 URL 编码） */
export function withParam(base: string, name: string, value: string | number): string {
  return `${base}${base.includes("?") ? "&" : "?"}${name}=${encodeURIComponent(String(value))}`;
}

/** 追加 `page=N`：页码分页的 withParam 简写 */
export function withPageParam(base: string, page: number): string {
  return withParam(base, "page", page);
}
