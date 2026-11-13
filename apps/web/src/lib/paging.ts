/**
 * 把外部传入的页码（来自 `?page=`，可能是小数、负数、NaN、Infinity）收束成 [1, totalPages] 内的整数。
 *
 * 为什么必须取整：页码最终变成 `OFFSET (page-1) * 每页条数`；小数会产生 `OFFSET 37.5`，
 * MySQL 直接报语法错误，游客一个 `?page=2.5` 就能打出 500。
 *  · NaN / 非数字 → 第 1 页
 *  · 小数向零取整（2.9 → 2）
 *  · ±Infinity 与越界值收束到两端（Infinity → 最后一页）
 */
export function clampPage(page: number, totalPages: number): number {
  const whole = Math.trunc(page) || 1; // NaN 与 0 都回到第 1 页
  return Math.min(Math.max(1, whole), Math.max(1, totalPages));
}

/** 解析 ?page= 为正整数页码；非正整数/NaN/小数回退 1（各列表筛选共用，M17 Step 5 提取） */
export function parsePageParam(raw: string | undefined): number {
  const page = Number(raw ?? "1");
  return Number.isInteger(page) && page > 0 ? page : 1;
}

/** 收束每页条数到 [1, max]，默认 def（各列表查询共用，M17 Step 5 提取） */
export function pageLimit(raw: number | undefined, def = 50, max = 200): number {
  return Math.min(Math.max(1, Math.trunc(raw ?? def) || def), max);
}

export interface PageBounds {
  page: number;
  totalPages: number;
  offset: number;
}

/** 统一计算列表分页边界；拒绝无效 pageSize，避免各查询重复拼 totalPages/offset。 */
export function pageBounds(total: number, rawPage: number, pageSize: number): PageBounds {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError("pageSize 必须是正整数");
  }
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize));
  const page = clampPage(rawPage, totalPages);
  return { page, totalPages, offset: (page - 1) * pageSize };
}
