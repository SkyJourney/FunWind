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
