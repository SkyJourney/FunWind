// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MIN_SIDE, centeredSquare, toNaturalCrop } from "./crop-math";

describe("toNaturalCrop：显示坐标 → 自然像素", () => {
  it("按显示与自然尺寸的比例放大，结果为整数", () => {
    // 显示 400×300，自然 800×600：比例 2
    expect(
      toNaturalCrop(
        { x: 10, y: 20, width: 100, height: 50 },
        { width: 400, height: 300 },
        { width: 800, height: 600 },
        { square: false },
      ),
    ).toEqual({
      x: 20,
      y: 40,
      width: 200,
      height: 100,
    });
  });

  it("小数坐标四舍五入为整数", () => {
    const r = toNaturalCrop(
      { x: 10.4, y: 0.6, width: 100.5, height: 60.2 },
      { width: 200, height: 200 },
      { width: 400, height: 400 },
      { square: false },
    );
    expect(r).not.toBeNull();
    for (const v of Object.values(r!)) expect(Number.isInteger(v)).toBe(true);
  });

  it("头像（square）：取较小边，保持 1:1", () => {
    const r = toNaturalCrop(
      { x: 0, y: 0, width: 200, height: 120 },
      { width: 400, height: 400 },
      { width: 400, height: 400 },
      { square: true },
    );
    expect(r).toEqual({ x: 0, y: 0, width: 120, height: 120 });
  });

  it("越出图片的部分被截断到边界内", () => {
    const r = toNaturalCrop(
      { x: 350, y: 0, width: 200, height: 100 },
      { width: 400, height: 300 },
      { width: 400, height: 300 },
      { square: false },
    );
    expect(r).toEqual({ x: 350, y: 0, width: 50, height: 100 });
  });

  it("太小（小于最小边）或零尺寸显示区域返回 null", () => {
    expect(
      toNaturalCrop(
        { x: 0, y: 0, width: 10, height: 100 },
        { width: 400, height: 300 },
        { width: 400, height: 300 },
        { square: false },
      ),
    ).toBeNull();
    expect(
      toNaturalCrop(
        { x: 0, y: 0, width: 10, height: 10 },
        { width: 0, height: 0 },
        { width: 400, height: 300 },
        { square: false },
      ),
    ).toBeNull();
  });

  it("性质：随机框选，结果总在图片内且边长不小于最小边（固定种子）", () => {
    let seed = 20261025;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 300; i++) {
      const natural = {
        width: 100 + Math.floor(rnd() * 3000),
        height: 100 + Math.floor(rnd() * 3000),
      };
      const display = {
        width: 200 + Math.floor(rnd() * 400),
        height: 200 + Math.floor(rnd() * 400),
      };
      const box = {
        x: rnd() * display.width,
        y: rnd() * display.height,
        width: rnd() * display.width,
        height: rnd() * display.height,
      };
      const r = toNaturalCrop(box, display, natural, { square: rnd() < 0.5 });
      if (r === null) continue;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(natural.width);
      expect(r.y + r.height).toBeLessThanOrEqual(natural.height);
      expect(r.width).toBeGreaterThanOrEqual(MIN_SIDE);
      expect(r.height).toBeGreaterThanOrEqual(MIN_SIDE);
    }
  });
});

describe("centeredSquare", () => {
  it("取中央最大正方形", () => {
    expect(centeredSquare({ width: 300, height: 200 })).toEqual({
      x: 50,
      y: 0,
      width: 200,
      height: 200,
    });
    expect(centeredSquare({ width: 200, height: 301 })).toEqual({
      x: 0,
      y: 50,
      width: 200,
      height: 200,
    });
  });
});
