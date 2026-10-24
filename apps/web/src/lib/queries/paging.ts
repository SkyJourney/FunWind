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
