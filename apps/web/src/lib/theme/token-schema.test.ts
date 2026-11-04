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
    it("COLOR_KEYS 有 22 个", () => {
      expect(COLOR_KEYS).toHaveLength(22);
      expect(new Set(COLOR_KEYS).size).toBe(22);
    });

    it("RADIUS_STEPS 包含 none/sm/md/lg/xl", () => {
      expect(RADIUS_STEPS).toEqual(["none", "sm", "md", "lg", "xl"]);
    });

    it("DISPLAY_FONTS 包含 system/songti/serif", () => {
      expect(DISPLAY_FONTS).toEqual(["system", "songti", "serif"]);
    });
  });
});
