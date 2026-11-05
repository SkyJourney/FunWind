import { describe, expect, it } from "vitest";
import { renderTokenVars } from "./token-render";
import { COLOR_KEYS, type TokenSet } from "./token-schema";

/** 输出值只允许出现这些字符：十六进制色、数字、单位，以及 var() / rgb() / linear-gradient() 与字体栈里的括号、引号、逗号、斜杠 */
const SAFE_VALUE = /^[#A-Za-z0-9 ,.%()"'/-]+$/;
const SAFE_KEY = /^--[a-z0-9-]+$/;
const EVIL = "1px;}</style><script>alert(1)</script>";

/** qy2010 风格的完整令牌集：22 个颜色 + 圆角 + 三档阴影 + 字体 + 渐变 + 板块卡参数 */
const FULL: TokenSet = {
  colors: {
    background: "#f6f3e7",
    foreground: "#33332f",
    card: "#fffdf4",
    "card-foreground": "#33332f",
    popover: "#fffdf4",
    "popover-foreground": "#33332f",
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

    it("完整令牌集：每个变量的值", () => {
      const result = renderTokenVars(FULL);
      expect(result["--background"]).toBe("#f6f3e7");
      expect(result["--primary"]).toBe("#147ba9");
      expect(result["--radius"]).toBe("var(--fw-radius-lg)");
      expect(result["--shadow-1"]).toBe("0px 1px 2px 0px rgb(120 100 40 / 0.1)");
      expect(result["--shadow-2"]).toBe("0px 4px 12px 0px rgb(120 100 40 / 0.14)");
      expect(result["--shadow-3"]).toBe("0px 12px 32px 0px rgb(120 100 40 / 0.18)");
      expect(result["--fw-font-display"]).toBe('"Songti SC", "STSong", SimSun, Georgia, serif');
      // 色标位置显式写出 0% / 100%：省略时 Chromium 的计算值不带位置，与静态 CSS 写法算出的值不相等
      expect(result["--gradient-brand"]).toBe("linear-gradient(135deg, #147ba9 0%, #c4b89c 100%)");
      expect(result["--band-width"]).toBe("8.5rem");
      expect(result["--band-angle"]).toBe("90deg");
      expect(result["--band-fade"]).toBe("0%");
      expect(result["--band-dim-opacity"]).toBe("1");
      expect(result["--band-mask-display"]).toBe("none");
      expect(result["--band-mask-color"]).toBe("#fffdf4");
    });

    it("完整令牌集：输出键的集合与顺序固定", () => {
      expect(Object.keys(renderTokenVars(FULL))).toEqual([
        ...COLOR_KEYS.map((key) => `--${key}`),
        "--radius",
        "--shadow-1",
        "--shadow-2",
        "--shadow-3",
        "--fw-font-display",
        "--gradient-brand",
        "--band-width",
        "--band-angle",
        "--band-fade",
        "--band-dim-opacity",
        "--band-mask-display",
        "--band-mask-color",
      ]);
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

    it("band.mask = true 输出 block；未给 maskColor 时不输出该变量（继承 var(--card)）", () => {
      const out = renderTokenVars({
        band: { width: 7, angle: 105, fade: 50, dim: 0.85, mask: true },
      });
      expect(out["--band-mask-display"]).toBe("block");
      expect(out).not.toHaveProperty("--band-mask-color");
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

    it("原型链上的名字不是合法档位（constructor / toString / __proto__）", () => {
      for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        expect(renderTokenVars({ radius: name } as unknown as TokenSet)).toEqual({});
        expect(renderTokenVars({ displayFont: name } as unknown as TokenSet)).toEqual({});
      }
    });
  });

  describe("变量名白名单", () => {
    it("只输出固定键集合，顺序固定（颜色按 COLOR_KEYS 顺序，之后是圆角）", () => {
      const tokens: TokenSet = {
        colors: { primary: "#147ba9", background: "#f6f3e7" },
        radius: "lg",
      };
      expect(Object.keys(renderTokenVars(tokens))).toEqual([
        "--background",
        "--primary",
        "--radius",
      ]);
    });

    it("tokens.colors 里的未知键（含 __proto__ / constructor）不会变成变量名", () => {
      const tokens = JSON.parse(
        '{"colors":{"primary":"#147ba9","evil;}":"#000000","__proto__":"#111111","constructor":"#222222"}}',
      ) as TokenSet;
      expect(Object.keys(renderTokenVars(tokens))).toEqual(["--primary"]);
    });
  });

  describe("未经校验的恶意输入（绕过 zod 直接交给渲染器）", () => {
    it("阴影的任一字段被注入或不是有限数字时，整条阴影被跳过且不抛错", () => {
      const ok = { x: 0, y: 1, blur: 2, spread: 0, color: "#000000", alpha: 0.1 };
      const variants: Array<Record<string, unknown>> = [
        { ...ok, x: EVIL },
        { ...ok, y: EVIL },
        { ...ok, blur: EVIL },
        { ...ok, spread: EVIL },
        { ...ok, alpha: EVIL },
        { ...ok, color: "red;background:url(x)" },
        { ...ok, color: 12 },
        { ...ok, x: Number.NaN },
        { ...ok, blur: Number.POSITIVE_INFINITY },
        { ...ok, alpha: Number.NEGATIVE_INFINITY },
      ];
      for (const shadow of variants) {
        const tokens = { shadows: { s1: shadow } } as unknown as TokenSet;
        expect(() => renderTokenVars(tokens)).not.toThrow();
        expect(renderTokenVars(tokens)).toEqual({});
      }
    });

    it("每个字段都塞恶意字符串：输出为空", () => {
      const tokens = {
        colors: Object.fromEntries(COLOR_KEYS.map((key) => [key, EVIL])),
        radius: EVIL,
        shadows: {
          s1: { x: EVIL, y: EVIL, blur: EVIL, spread: EVIL, color: EVIL, alpha: EVIL },
          s2: EVIL,
          s3: null,
        },
        displayFont: EVIL,
        brandGradient: { angle: EVIL, from: EVIL, to: EVIL },
        band: { width: EVIL, angle: EVIL, fade: EVIL, dim: EVIL, mask: EVIL, maskColor: EVIL },
      } as unknown as TokenSet;
      expect(renderTokenVars(tokens)).toEqual({});
    });

    it("带合法前缀的夹带也被拒绝：颜色必须整串是 #RRGGBB；同级的合法字段照常输出", () => {
      const sneaky = [
        "#000000;}</style>",
        "x#000000",
        "#00000g",
        "#0000000",
        "#abc",
        " #000000",
        "#000000\n",
      ];
      for (const value of sneaky) {
        const tokens = {
          colors: { primary: value },
          shadows: { s1: { x: 0, y: 1, blur: 2, spread: 0, color: value, alpha: 0.1 } },
          brandGradient: { angle: 0, from: value, to: "#ffffff" },
          band: { width: 1, angle: 0, fade: 0, dim: 1, mask: true, maskColor: value },
        } as unknown as TokenSet;
        expect(Object.keys(renderTokenVars(tokens)), JSON.stringify(value)).toEqual([
          "--band-width",
          "--band-angle",
          "--band-fade",
          "--band-dim-opacity",
          "--band-mask-display",
        ]);
      }
    });

    it("渐变与遮罩色的大写十六进制规范化为小写", () => {
      const out = renderTokenVars({
        brandGradient: { angle: 0, from: "#AABBCC", to: "#DDEEFF" },
        band: { width: 1, angle: 0, fade: 0, dim: 1, mask: true, maskColor: "#ABCDEF" },
      });
      expect(out["--gradient-brand"]).toBe("linear-gradient(0deg, #aabbcc 0%, #ddeeff 100%)");
      expect(out["--band-mask-color"]).toBe("#abcdef");
    });

    it("板块卡数值字段不是有限数字时跳过该变量，其余照常输出", () => {
      const tokens = {
        band: {
          width: Number.NaN,
          angle: Number.POSITIVE_INFINITY,
          fade: Number.NaN,
          dim: Number.NEGATIVE_INFINITY,
          mask: true,
        },
      } as unknown as TokenSet;
      expect(renderTokenVars(tokens)).toEqual({ "--band-mask-display": "block" });
    });

    it("品牌渐变的角度不是有限数字时跳过", () => {
      for (const angle of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const tokens = { brandGradient: { angle, from: "#000000", to: "#ffffff" } } as TokenSet;
        expect(renderTokenVars(tokens)).toEqual({});
      }
    });

    it("安全字符集检查对合法输出不是空转：键与值都满足，且一个都没丢", () => {
      const out = renderTokenVars(FULL);
      expect(Object.keys(out)).toHaveLength(COLOR_KEYS.length + 12);
      for (const [key, value] of Object.entries(out)) {
        expect(key, key).toMatch(SAFE_KEY);
        expect(value, key).toMatch(SAFE_VALUE);
      }
      expect(EVIL).not.toMatch(SAFE_VALUE);
    });
  });
});
