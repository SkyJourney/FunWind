// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseCropField, validateCrop } from "./crop";
import { MIN_CROP } from "./types";

const SIZE = { width: 640, height: 480 };

describe("validateCrop", () => {
  it("合法矩形通过，整数原样返回", () => {
    expect(validateCrop({ x: 0, y: 0, width: 640, height: 480 }, SIZE, { square: false })).toEqual({
      ok: true,
      crop: { x: 0, y: 0, width: 640, height: 480 },
    });
  });

  it("非对象、缺字段、非整数（含 NaN / 小数 / 字符串）一律拒绝", () => {
    const bad: unknown[] = [
      null,
      "x",
      {},
      { x: 0, y: 0, width: 100 },
      { x: 0.5, y: 0, width: 100, height: 100 },
      { x: NaN, y: 0, width: 100, height: 100 },
      { x: "0", y: 0, width: 100, height: 100 },
    ];
    for (const b of bad) expect(validateCrop(b, SIZE, { square: false }).ok).toBe(false);
  });

  it("负数、过小、越界拒绝", () => {
    expect(validateCrop({ x: -1, y: 0, width: 100, height: 100 }, SIZE, { square: false }).ok).toBe(
      false,
    );
    expect(
      validateCrop({ x: 0, y: 0, width: MIN_CROP - 1, height: 100 }, SIZE, { square: false }).ok,
    ).toBe(false);
    expect(
      validateCrop({ x: 600, y: 0, width: 100, height: 100 }, SIZE, { square: false }).ok,
    ).toBe(false);
  });

  it("头像必须 1:1", () => {
    expect(
      validateCrop({ x: 0, y: 0, width: 200, height: 100 }, SIZE, { square: true }),
    ).toMatchObject({
      ok: false,
    });
    expect(validateCrop({ x: 0, y: 0, width: 200, height: 200 }, SIZE, { square: true }).ok).toBe(
      true,
    );
  });

  it("性质：随机在范围内的矩形全部通过；任一边界外扰动全部拒绝（固定种子）", () => {
    let seed = 20261025;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    for (let i = 0; i < 300; i++) {
      const width = int(MIN_CROP, SIZE.width);
      const height = int(MIN_CROP, SIZE.height);
      const x = int(0, SIZE.width - width);
      const y = int(0, SIZE.height - height);
      expect(validateCrop({ x, y, width, height }, SIZE, { square: false }).ok).toBe(true);
      // 扰动：右边界越界一个像素
      expect(
        validateCrop({ x: SIZE.width - width + 1, y, width, height }, SIZE, { square: false }).ok,
      ).toBe(false);
    }
  });
});

describe("parseCropField", () => {
  it("空或缺失视为不裁剪；非法 JSON 单独标记", () => {
    expect(parseCropField(undefined)).toEqual({ kind: "none" });
    expect(parseCropField("")).toEqual({ kind: "none" });
    expect(parseCropField("{不是json")).toEqual({ kind: "invalid" });
    expect(parseCropField('{"x":1}')).toEqual({ kind: "value", value: { x: 1 } });
  });
});
