import { describe, expect, it } from "vitest";
import { renderTokenVars } from "./token-render";
import type { TokenSet } from "./token-schema";

describe("token-render", () => {
  describe("renderTokenVars 黄金输出", () => {
    it("空 TokenSet 返回空对象", () => {
      expect(renderTokenVars({})).toEqual({});
    });

    it("仅颜色", () => {
      const tokens: TokenSet = {
        colors: { primary: "#147BA9", background: "#F6F3E7" },
      };
      expect(renderTokenVars(tokens)).toEqual({
        "--primary": "#147ba9",
        "--background": "#f6f3e7",
      });
    });

    it("完整 qy2010 令牌集", () => {
      const tokens: TokenSet = {
        colors: {
          background: "#f6f3e7",
          foreground: "#33332f",
          card: "#fffdf4",
          "card-foreground": "#33332f",
          primary: "#147ba9",
          "primary-foreground": "#ffffff",
          secondary: "#f8f5e8",
          "secondary-foreground": "#65644b",
          muted: "#f8f5e8",
          "muted-foreground": "#65644b",
          accent: "#f8f5e8",
          "accent-foreground": "#33332f",
          destructive: "#b91c1c",
          "destructive-foreground": "#ffffff",
          success: "#166534",
          warning: "#8a5200",
          info: "#1d4ed8",
          border: "#e7e2ce",
          input: "#e7e2ce",
          ring: "#147ba9",
          popover: "#fffdf4",
          "popover-foreground": "#33332f",
        },
        radius: "lg",
        shadows: {
          s1: { x: 0, y: 1, blur: 2, spread: 0, color: "#786428", alpha: 0.1 },
          s2: { x: 0, y: 4, blur: 12, spread: 0, color: "#786428", alpha: 0.14 },
          s3: { x: 0, y: 12, blur: 32, spread: 0, color: "#786428", alpha: 0.18 },
        },
        displayFont: "songti",
        brandGradient: { angle: 135, from: "#147ba9", to: "#c4b89c" },
        band: { width: 8.5, angle: 90, fade: 0, dim: 1, mask: false, maskColor: "#fffdf4" },
      };
      const result = renderTokenVars(tokens);
      expect(result["--background"]).toBe("#f6f3e7");
      expect(result["--primary"]).toBe("#147ba9");
      expect(result["--radius"]).toBe("var(--fw-radius-lg)");
      expect(result["--shadow-1"]).toBe("0px 1px 2px 0px rgb(120 100 40 / 0.1)");
      expect(result["--shadow-2"]).toBe("0px 4px 12px 0px rgb(120 100 40 / 0.14)");
      expect(result["--fw-font-display"]).toBe('"Songti SC", "STSong", SimSun, Georgia, serif');
      expect(result["--gradient-brand"]).toBe("linear-gradient(135deg, #147ba9, #c4b89c)");
      expect(result["--band-width"]).toBe("8.5rem");
      expect(result["--band-angle"]).toBe("90deg");
      expect(result["--band-fade"]).toBe("0%");
      expect(result["--band-dim-opacity"]).toBe("1");
      expect(result["--band-mask-display"]).toBe("none");
      expect(result["--band-mask-color"]).toBe("#fffdf4");
    });

    it("radius: none 映射为 0px", () => {
      expect(renderTokenVars({ radius: "none" })).toEqual({ "--radius": "0px" });
    });

    it("displayFont 枚举正确映射", () => {
      expect(renderTokenVars({ displayFont: "system" })).toEqual({
        "--fw-font-display": "var(--fw-font-sans)",
      });
      expect(renderTokenVars({ displayFont: "serif" })["--fw-font-display"]).toContain("Georgia");
    });

    it("band.mask = true 输出 block", () => {
      const tokens: TokenSet = {
        band: { width: 7, angle: 105, fade: 50, dim: 0.85, mask: true },
      };
      expect(renderTokenVars(tokens)["--band-mask-display"]).toBe("block");
    });
  });

  describe("防御性：跳过无效值", () => {
    it("颜色非 #RRGGBB 格式被跳过", () => {
      const tokens = { colors: { primary: "red" } } as unknown as TokenSet;
      expect(renderTokenVars(tokens)).toEqual({});
    });

    it("未知 radius 值被跳过", () => {
      const tokens = { radius: "xxl" } as unknown as TokenSet;
      expect(renderTokenVars(tokens)).toEqual({});
    });

    it("未知 displayFont 值被跳过", () => {
      const tokens = { displayFont: "comic-sans" } as unknown as TokenSet;
      expect(renderTokenVars(tokens)).toEqual({});
    });
  });

  describe("变量名白名单", () => {
    it("只输出固定键集合", () => {
      const tokens: TokenSet = {
        colors: { primary: "#147ba9", background: "#f6f3e7" },
        radius: "lg",
      };
      const result = renderTokenVars(tokens);
      const keys = Object.keys(result);
      expect(keys.every((k) => k.startsWith("--"))).toBe(true);
      // 颜色按 COLOR_KEYS 顺序，background 在 primary 前
      expect(keys).toContain("--primary");
      expect(keys).toContain("--background");
      expect(keys).toContain("--radius");
    });
  });
});
