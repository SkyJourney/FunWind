/**
 * 后台列表页共享的 URL 查询构造与参数解析（审查 F-19：取代各页手写的 baseQuery 闭包与页码解析）。
 * 值为 undefined / 空串 / page=1 的参数不进 URL——筛选态干净且可复制。
 */

export function buildAdminQuery(
  path: string,
  params: Record<string, string | number | undefined>,
  overrides: Record<string, string | number | undefined> = {},
): string {
  const sp = new URLSearchParams();
  const all: Record<string, string | number | undefined> = { ...params, ...overrides };
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined || v === "") continue;
    if (k === "page" && v === 1) continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * 在可能已带 query 的回跳路径上追加一个键值对（管理 Action 回跳用）。
 * back 由页面 baseQuery 生成、可能已含 `?`，硬拼 `?` 会产出畸形 URL——统一走这里。
 */
export function appendQueryParam(path: string, key: string, value: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

// —— 列表页多尺寸/密度/日期范围（M19 S3，D2 定稿：默认统一 20，档位 10/20/50/100） ——

export const ADMIN_PAGE_SIZES = [10, 20, 50, 100] as const;
export const ADMIN_DEFAULT_SIZE = 20;

export type AdminDensity = "cozy" | "compact";

export interface AdminListParams {
  /** 每页条数（白名单校验后；默认 20，默认值不进 URL） */
  size: number;
  /** 行高密度：cozy（默认，不进 URL）/ compact */
  density: AdminDensity;
  /** 起止日期（YYYY-MM-DD，含当天）；缺失/非法/from>to 时为 undefined */
  from?: string;
  to?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 列表页通用参数解析：size 走档位白名单、density 两档、日期必须完整合法且 from ≤ to，
 * 任何非法/缺失一律回落默认——页码仍由各页 parseAdminPage 按原语义解析（不在此处收口，避免改变存量取整行为）。
 */
export function parseAdminListParams(
  sp: Record<string, string | undefined>,
  defaultSize: number = ADMIN_DEFAULT_SIZE,
): AdminListParams {
  const rawSize = Number(sp.size);
  const size = (ADMIN_PAGE_SIZES as readonly number[]).includes(rawSize) ? rawSize : defaultSize;
  const density: AdminDensity = sp.density === "compact" ? "compact" : "cozy";
  const from = sp.from && DATE_RE.test(sp.from) ? sp.from : undefined;
  const to = sp.to && DATE_RE.test(sp.to) ? sp.to : undefined;
  const rangeValid = !from || !to || from <= to;
  return {
    size,
    density,
    ...(from && rangeValid ? { from } : {}),
    ...(to && rangeValid ? { to } : {}),
  };
}

/** 密度 → 数据单元格 padding 类（AdminDataTable 已内置；手写表格页拼 td 时复用） */
export function densityCellClass(density: AdminDensity): string {
  return density === "compact" ? "px-2.5 py-1" : "px-3 py-1.5";
}

/**
 * 页码解析：默认拒绝非正整数；既有列表用 number-or-one 保留 Number(raw) || 1 的接受面，
 * 小数 / 负数 / Infinity 继续交给原服务层的分页策略处理，不在展示层改变取整或夹取行为。
 */
export function parseAdminPage(
  raw: string | undefined,
  mode: "positive-integer" | "number-or-one" = "positive-integer",
): number {
  const n = Number(raw ?? "1");
  if (mode === "number-or-one") return n || 1;
  return Number.isInteger(n) && n > 0 ? n : 1;
}
