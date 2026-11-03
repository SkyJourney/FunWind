/**
 * 每日配额：今天已创建的数量达到上限则违规，计数口径由调用方保持（主题含已删除，上传含去重命中）。
 * max 为 0 = 不限。
 */
export function dailyQuotaExceeded(createdToday: number, max: number): boolean {
  return max > 0 && createdToday >= max;
}
