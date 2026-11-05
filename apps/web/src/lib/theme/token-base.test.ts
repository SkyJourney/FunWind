import { describe, expect, it } from "vitest";
import { contrastWarnings } from "./contrast-advisor";
import { BASE_COLORS, effectiveColors } from "./token-base";
import { COLOR_KEYS } from "./token-schema";

/**
 * 基础层颜色表。常量与 CSS 的逐项比对（防漂移）在 src/test/token-contrast.test.ts，
 * 这里只测常量自身的形状与 effectiveColors 的合并语义。
 */

describe("BASE_COLORS", () => {
  it.each(["light", "dark"] as const)("%s：恰好 22 个键，值都是小写 #rrggbb", (mode) => {
    expect(Object.keys(BASE_COLORS[mode]).sort()).toEqual([...COLOR_KEYS].sort());
    for (const [key, value] of Object.entries(BASE_COLORS[mode])) {
      expect(value, `${mode}.${key}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("浅深两档是两张不同的表", () => {
    expect(BASE_COLORS.light.background).toBe("#f8fafc");
    expect(BASE_COLORS.dark.background).toBe("#020617");
  });
});

describe("effectiveColors", () => {
  it("没有覆盖时等于基础层，且是副本：改返回值不会污染基础表", () => {
    const light = effectiveColors("light");
    expect(light).toEqual(BASE_COLORS.light);
    expect(light).not.toBe(BASE_COLORS.light);
    light.primary = "#000000";
    expect(BASE_COLORS.light.primary).toBe("#0e7490");
    expect(effectiveColors("light").primary).toBe("#0e7490");
  });

  it("浅深两档各取各自的基础层", () => {
    expect(effectiveColors("light").background).toBe("#f8fafc");
    expect(effectiveColors("dark").background).toBe("#020617");
  });

  it("合法覆盖生效，大写规范化为小写，没覆盖的键保持基础值", () => {
    const out = effectiveColors("light", { primary: "#147BA9", ring: "#112233" });
    expect(out.primary).toBe("#147ba9");
    expect(out.ring).toBe("#112233");
    expect(out.background).toBe(BASE_COLORS.light.background);
    expect(out.warning).toBe(BASE_COLORS.light.warning);
  });

  it.each(["red", "#abc", "#12345g", "", "#aabbccdd", " #aabbcc", "aabbcc"])(
    "不合法的覆盖 %j 被忽略，回落基础层",
    (bad) => {
      expect(effectiveColors("dark", { primary: bad }).primary).toBe(BASE_COLORS.dark.primary);
    },
  );

  it("覆盖里的未知键不进入结果", () => {
    const overrides = JSON.parse('{"primary":"#112233","nope":"#445566","__proto__":"#778899"}');
    const out = effectiveColors("light", overrides);
    expect(Object.keys(out).sort()).toEqual([...COLOR_KEYS].sort());
    expect(out.primary).toBe("#112233");
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("每次调用返回新对象", () => {
    expect(effectiveColors("light")).not.toBe(effectiveColors("light"));
  });
});

describe("基础层喂给对比度顾问", () => {
  it("默认浅色只有 primary-tint-bg 一项不达标（4.487），默认暗色全部达标", () => {
    expect(contrastWarnings(effectiveColors("light")).map((check) => check.id)).toEqual([
      "primary-tint-bg",
    ]);
    expect(contrastWarnings(effectiveColors("dark"))).toEqual([]);
  });

  it("覆盖随之改变结果：把 foreground 压成浅灰，正文两对变红，原有的那一项仍在", () => {
    const ids = contrastWarnings(effectiveColors("light", { foreground: "#aaaaaa" })).map(
      (check) => check.id,
    );
    expect(ids).toEqual(["fg-bg", "fg-card", "primary-tint-bg"]);
  });
});
