/**
 * 切块几何（纯函数，不依赖 sharp，便于单测）。导出器见 readable-tiles.ts，规程见 docs/VISUAL-VERIFICATION.md。
 *
 * 为什么必须切块：截图交给多模态模型阅读时，大图会在送达前被缩小，小字随之变糊。
 * 2026-11-04 用随机码盲测的实测结果：
 *   - 800×800 以内：9px 文字 10/10 读对；375×800 原尺寸切片 15/15（含 9px）；
 *   - 1280×900：14px 以上读对，12px 以下开始读错；
 *   - 375×1400：14px 读对、11px 读不对；375×2400 整页长图：14px 也全部读错。
 */

/** 单块（含标签条）的最大边长，来自上面的盲测；改动前必须重做盲测 */
export const TILE_MAX = 800;
/** 标签条高度（两行 11px 文字） */
export const BANNER_H = 30;
/** 相邻块的重叠像素，避免一行文字恰好被切在边界上 */
export const TILE_OVERLAP = 24;

export type Span = { start: number; size: number };

/**
 * 把长度 total 切成每段不超过 max、相邻段重叠 overlap 的区间。
 * 段数取最少，再把长度均分，避免出现「800 + 800 + 20」这种末尾碎片。
 */
export function tileSpans(total: number, max: number, overlap = TILE_OVERLAP): Span[] {
  if (total <= max) return [{ start: 0, size: total }];
  const count = Math.ceil((total - overlap) / (max - overlap));
  const size = Math.ceil((total + (count - 1) * overlap) / count);
  return Array.from({ length: count }, (_, i) => {
    const start = i * (size - overlap);
    return { start, size: Math.min(size, total - start) };
  });
}
