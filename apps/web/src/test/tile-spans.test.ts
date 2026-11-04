import { describe, expect, it } from "vitest";
import { TILE_MAX, TILE_OVERLAP, tileSpans } from "../../e2e/support/tile-spans";

/** 目视验收切块的几何（e2e/support/tile-spans.ts）：切错会让整页某一段永远不被读到 */
describe("tileSpans", () => {
  it("不超过上限时只有一块，原样覆盖", () => {
    expect(tileSpans(500, 770)).toEqual([{ start: 0, size: 500 }]);
    expect(tileSpans(770, 770)).toEqual([{ start: 0, size: 770 }]);
  });

  it("超过上限时均分，而不是「满块 + 末尾碎片」", () => {
    // 1000 高、上限 770：最少 2 块，均分约 512，而不是 770 + 254
    const spans = tileSpans(1000, 770);
    expect(spans).toHaveLength(2);
    expect(Math.abs(spans[0].size - spans[1].size)).toBeLessThanOrEqual(1);
  });

  it("任意长度：每块不超限、首块从 0 起、末块到 total 止、相邻块重叠且无缝", () => {
    for (let total = 1; total <= 5000; total += 37) {
      const spans = tileSpans(total, 770);
      expect(spans[0].start).toBe(0);
      const last = spans[spans.length - 1];
      expect(last.start + last.size).toBe(total);
      for (const [i, span] of spans.entries()) {
        expect(span.size).toBeGreaterThan(0);
        expect(span.size).toBeLessThanOrEqual(770);
        if (i > 0) {
          const prev = spans[i - 1];
          // 相邻块首尾重叠至少 overlap 像素：一行文字被切在边界上时，总有一块完整包含它
          expect(prev.start + prev.size - span.start).toBeGreaterThanOrEqual(
            Math.min(TILE_OVERLAP, prev.size),
          );
        }
      }
    }
  });

  it("块数最少：不会多切一块", () => {
    // 仅比一块多一点点也必须切成 2 块；恰好 2 块能放下的长度不得切成 3 块
    expect(tileSpans(771, 770)).toHaveLength(2);
    expect(tileSpans(2 * 770 - TILE_OVERLAP, 770)).toHaveLength(2);
    expect(tileSpans(2 * 770 - TILE_OVERLAP + 1, 770)).toHaveLength(3);
  });

  it("项目上限 TILE_MAX 与盲测结论一致（800），改动须先重做盲测", () => {
    expect(TILE_MAX).toBe(800);
  });
});
