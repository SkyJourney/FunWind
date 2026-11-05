import { describe, expect, it } from "vitest";
import {
  COLOR_KEYS,
  DISPLAY_FONTS,
  RADIUS_STEPS,
  tokenSetSchema,
  tokensSchema,
  type TokenSet,
} from "./token-schema";

describe("token-schema", () => {
  describe("接受有效 TokenSet", () => {
    it("空对象", () => {
      expect(tokenSetSchema.parse({})).toEqual({});
    });

    it("仅颜色（部分键）", () => {
      const input = { colors: { primary: "#147ba9", background: "#f6f3e7" } };
      expect(tokenSetSchema.parse(input)).toEqual(input);
    });

    it("完整 TokenSet", () => {
      const input: TokenSet = {
        colors: {
          background: "#f6f3e7",
          foreground: "#33332f",
          card: "#fffdf4",
          "card-foreground": "#33332f",
          primary: "#147ba9",
          "primary-foreground": "#ffffff",
        },
        radius: "lg",
        shadows: {
          s1: { x: 0, y: 1, blur: 2, spread: 0, color: "#786428", alpha: 0.1 },
          s2: { x: 0, y: 4, blur: 12, spread: 0, color: "#786428", alpha: 0.14 },
        },
        displayFont: "songti",
        brandGradient: { angle: 135, from: "#147ba9", to: "#f6f3e7" },
        band: { width: 8.5, angle: 90, fade: 0, dim: 1, mask: false },
      };
      expect(tokenSetSchema.parse(input)).toEqual(input);
    });
  });

  describe("拒绝无效 TokenSet", () => {
    it("colors 含未知键", () => {
      expect(() => tokenSetSchema.parse({ colors: { unknown: "#aaaaaa" } })).toThrow();
    });

    it("colors 值非 #RRGGBB", () => {
      expect(() => tokenSetSchema.parse({ colors: { primary: "red" } })).toThrow();
      expect(() => tokenSetSchema.parse({ colors: { primary: "#ff00" } })).toThrow();
      expect(() => tokenSetSchema.parse({ colors: { primary: "#ff00gg" } })).toThrow();
    });

    it("radius 非枚举值", () => {
      expect(() => tokenSetSchema.parse({ radius: "xxl" })).toThrow();
    });

    it("shadows 含未知键", () => {
      expect(() =>
        tokenSetSchema.parse({
          shadows: { s4: { x: 0, y: 0, blur: 0, spread: 0, color: "#000000", alpha: 1 } },
        }),
      ).toThrow();
    });

    it("shadow 字段超范围", () => {
      expect(() =>
        tokenSetSchema.parse({
          shadows: { s1: { x: 100, y: 0, blur: 0, spread: 0, color: "#000000", alpha: 1 } },
        }),
      ).toThrow();
      expect(() =>
        tokenSetSchema.parse({
          shadows: { s1: { x: 0, y: 0, blur: 100, spread: 0, color: "#000000", alpha: 1 } },
        }),
      ).toThrow();
      expect(() =>
        tokenSetSchema.parse({
          shadows: { s1: { x: 0, y: 0, blur: 0, spread: 0, color: "#000000", alpha: 1.5 } },
        }),
      ).toThrow();
    });

    it("displayFont 非枚举值", () => {
      expect(() => tokenSetSchema.parse({ displayFont: "comic-sans" })).toThrow();
    });

    it("brandGradient 角度超范围", () => {
      expect(() =>
        tokenSetSchema.parse({ brandGradient: { angle: 360, from: "#000000", to: "#ffffff" } }),
      ).toThrow();
    });

    it("band.width 超范围", () => {
      expect(() =>
        tokenSetSchema.parse({ band: { width: 20, angle: 0, fade: 0, dim: 1, mask: false } }),
      ).toThrow();
    });

    it("band.width 超过两位小数", () => {
      expect(() =>
        tokenSetSchema.parse({ band: { width: 8.123, angle: 0, fade: 0, dim: 1, mask: false } }),
      ).toThrow();
    });

    it("band 缺少必填字段", () => {
      expect(() => tokenSetSchema.parse({ band: { width: 8 } })).toThrow();
    });

    it("顶层含未知键", () => {
      expect(() => tokenSetSchema.parse({ unknown: "value" })).toThrow();
    });
  });

  describe("字段范围与结构（逐项固定边界）", () => {
    const accepts = (value: unknown) => tokenSetSchema.safeParse(value).success;
    const shadow = { x: 0, y: 1, blur: 2, spread: 0, color: "#000000", alpha: 0.1 };
    const withShadow = (patch: Record<string, unknown>) => ({
      shadows: { s1: { ...shadow, ...patch } },
    });
    const gradient = (patch: Record<string, unknown>) => ({
      brandGradient: { angle: 120, from: "#000000", to: "#ffffff", ...patch },
    });
    const band = (patch: Record<string, unknown>) => ({
      band: { width: 8.5, angle: 90, fade: 0, dim: 1, mask: false, ...patch },
    });

    it.each([
      ["x", 64, -64, 65, -65],
      ["y", 64, -64, 65, -65],
      ["blur", 80, 0, 81, -1],
      ["spread", 32, -32, 33, -33],
    ])("阴影 %s：接受上下界 %s / %s，拒绝越界 %s / %s", (field, hi, lo, overHi, underLo) => {
      expect(accepts(withShadow({ [field]: hi }))).toBe(true);
      expect(accepts(withShadow({ [field]: lo }))).toBe(true);
      expect(accepts(withShadow({ [field]: overHi }))).toBe(false);
      expect(accepts(withShadow({ [field]: underLo }))).toBe(false);
    });

    it.each(["x", "y", "blur", "spread"])("阴影 %s 必须是整数", (field) => {
      expect(accepts(withShadow({ [field]: 1.5 }))).toBe(false);
    });

    it("阴影 alpha：0–1、最多两位小数", () => {
      for (const alpha of [0, 0.1, 0.14, 1])
        expect(accepts(withShadow({ alpha })), `${alpha}`).toBe(true);
      for (const alpha of [-0.01, 1.01, 0.123]) {
        expect(accepts(withShadow({ alpha })), `${alpha}`).toBe(false);
      }
    });

    it("阴影对象不接受多余字段，缺字段也不行", () => {
      expect(accepts(withShadow({ extra: 1 }))).toBe(false);
      expect(accepts(withShadow({ color: "red" }))).toBe(false);
      expect(accepts(withShadow({ color: "#fff" }))).toBe(false);
      const { alpha: _alpha, ...missing } = shadow;
      expect(accepts({ shadows: { s1: missing } })).toBe(false);
    });

    it("品牌渐变：角度是 0–359 的整数，颜色合法，不接受多余字段", () => {
      expect(accepts(gradient({}))).toBe(true);
      expect(accepts(gradient({ angle: 0 }))).toBe(true);
      expect(accepts(gradient({ angle: 359 }))).toBe(true);
      expect(accepts(gradient({ angle: 360 }))).toBe(false);
      expect(accepts(gradient({ angle: -1 }))).toBe(false);
      expect(accepts(gradient({ angle: 1.5 }))).toBe(false);
      expect(accepts(gradient({ extra: 1 }))).toBe(false);
      expect(accepts(gradient({ from: "red" }))).toBe(false);
      expect(accepts(gradient({ to: "#fff" }))).toBe(false);
    });

    it("板块卡参数：各字段的边界与类型，不接受多余字段", () => {
      expect(accepts(band({}))).toBe(true);
      expect(accepts(band({ width: 0 }))).toBe(true);
      expect(accepts(band({ width: 16 }))).toBe(true);
      expect(accepts(band({ width: 16.01 }))).toBe(false);
      expect(accepts(band({ width: -0.01 }))).toBe(false);
      expect(accepts(band({ angle: 359 }))).toBe(true);
      expect(accepts(band({ angle: 360 }))).toBe(false);
      expect(accepts(band({ angle: -1 }))).toBe(false);
      expect(accepts(band({ angle: 1.5 }))).toBe(false);
      expect(accepts(band({ fade: 100 }))).toBe(true);
      expect(accepts(band({ fade: 101 }))).toBe(false);
      expect(accepts(band({ fade: -1 }))).toBe(false);
      expect(accepts(band({ fade: 1.5 }))).toBe(false);
      expect(accepts(band({ dim: 0 }))).toBe(true);
      expect(accepts(band({ dim: 1.01 }))).toBe(false);
      expect(accepts(band({ dim: 0.123 }))).toBe(false);
      expect(accepts(band({ mask: "yes" }))).toBe(false);
      expect(accepts(band({ maskColor: "#fffdf4" }))).toBe(true);
      expect(accepts(band({ maskColor: "white" }))).toBe(false);
      expect(accepts(band({ extra: 1 }))).toBe(false);
    });

    it("颜色：大小写十六进制都接受，三位简写、八位带透明度、缺 # 都拒绝", () => {
      expect(accepts({ colors: { primary: "#AABBCC" } })).toBe(true);
      expect(accepts({ colors: { primary: "#aabbcc" } })).toBe(true);
      expect(accepts({ colors: { primary: "#abc" } })).toBe(false);
      expect(accepts({ colors: { primary: "#aabbccdd" } })).toBe(false);
      expect(accepts({ colors: { primary: "aabbcc" } })).toBe(false);
    });

    it("颜色：键值为 undefined 被拒绝（编辑器清除颜色时必须删键，不能置 undefined）", () => {
      expect(accepts({ colors: { primary: undefined } })).toBe(false);
    });

    it("颜色：原型相关的键名不会进入输出，也不污染原型", () => {
      for (const key of ["constructor", "toString", "hasOwnProperty"]) {
        expect(accepts(JSON.parse(`{"colors":{"${key}":"#111111"}}`)), key).toBe(false);
      }
      // __proto__ 经 JSON.parse 成为自有属性；zod 遍历 record 时跳过它：解析成功，但输出里没有，原型也没变
      const parsed = tokenSetSchema.parse(
        JSON.parse('{"colors":{"__proto__":"#111111","primary":"#222222"}}'),
      );
      expect(Object.keys(parsed.colors ?? {})).toEqual(["primary"]);
      expect(Object.getPrototypeOf(parsed.colors)).toBe(Object.prototype);
      expect(Object.keys(Object.prototype)).toEqual([]);
    });
  });

  describe("tokensSchema（浅 / 深两档）", () => {
    it("空对象", () => {
      expect(tokensSchema.parse({})).toEqual({});
    });

    it("仅浅色", () => {
      const input = { light: { colors: { primary: "#147ba9" } } };
      expect(tokensSchema.parse(input)).toEqual(input);
    });

    it("浅 + 深", () => {
      const input = {
        light: { colors: { primary: "#147ba9" } },
        dark: { colors: { primary: "#22d3ee" } },
      };
      expect(tokensSchema.parse(input)).toEqual(input);
    });

    it("拒绝未知顶层键", () => {
      expect(() => tokensSchema.parse({ unknown: {} })).toThrow();
    });
  });

  describe("常量完整性", () => {
    it("COLOR_KEYS 恰为 semantic.css 的 22 个语义色变量名，顺序固定", () => {
      expect(COLOR_KEYS).toHaveLength(22);
      expect(new Set(COLOR_KEYS).size).toBe(22);
      expect([...COLOR_KEYS]).toEqual([
        "background",
        "foreground",
        "card",
        "card-foreground",
        "popover",
        "popover-foreground",
        "primary",
        "primary-foreground",
        "secondary",
        "secondary-foreground",
        "muted",
        "muted-foreground",
        "accent",
        "accent-foreground",
        "destructive",
        "destructive-foreground",
        "success",
        "warning",
        "info",
        "border",
        "input",
        "ring",
      ]);
    });

    it("RADIUS_STEPS 包含 none/sm/md/lg/xl", () => {
      expect(RADIUS_STEPS).toEqual(["none", "sm", "md", "lg", "xl"]);
    });

    it("DISPLAY_FONTS 包含 system/songti/serif", () => {
      expect(DISPLAY_FONTS).toEqual(["system", "songti", "serif"]);
    });
  });
});
